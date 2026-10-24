//! Serves the OBS overlay page and hosts the WebSocket feed it consumes.
//! Sharing one port lets the overlay derive its socket URL from its own
//! location, so there is nothing to configure in OBS beyond the URL.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path as UrlPath, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, oneshot, watch};

const OVERLAY_HTML: &str = include_str!("../../web/overlay.html");

/// Query parameter carrying the access key. Short — this goes in an OBS field.
pub const KEY_PARAM: &str = "k";

const LOOPBACK_HOSTS: [&str; 4] = ["127.0.0.1", "localhost", "[::1]", "::1"];

/// Failed-attempt throttling. Not a brute-force defence — 128 bits of key
/// makes guessing hopeless on its own. This stops an automated scanner burning
/// a streamer's CPU and sockets mid-broadcast.
const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_MAX_FAILURES: u32 = 20;

/// Ceiling on simultaneous remote viewers. The host's own OBS is never counted
/// against it, so flooding the tunnel cannot lock someone out of their overlay.
const MAX_REMOTE_CLIENTS: u32 = 16;

/// Nothing a client sends is ever read, so any sizeable frame is abuse.
const MAX_PAYLOAD_BYTES: usize = 1024;

/// Font files the overlay may load from the fonts folder, by extension.
const FONT_TYPES: [(&str, &str); 4] = [("ttf", "font/ttf"), ("otf", "font/otf"), ("woff", "font/woff"), ("woff2", "font/woff2")];

fn font_type(name: &str) -> Option<&'static str> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    FONT_TYPES.iter().find(|(e, _)| *e == ext).map(|(_, t)| *t)
}

/// The font files directly in `dir`, sorted. Only names on this list are
/// ever served, which is what keeps `/fonts/` from reaching anything else.
pub fn font_files(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| font_type(n).is_some())
        .collect();
    out.sort_by_key(|n| n.to_lowercase());
    out
}

/// A fresh access key: 128 bits, URL-safe, 22 characters.
pub fn new_access_key() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the OS random source");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Constant-time compare that tolerates unequal lengths: both sides are hashed
/// to a fixed width first.
fn key_matches(given: &str, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let a = Sha256::digest(given.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Did this request arrive over the tunnel rather than from this machine?
///
/// The tunnel connects to 127.0.0.1 like OBS does, so the socket address
/// cannot tell them apart. The Host header can, and Cloudflare's own headers
/// are a second, independent tell.
fn is_local(headers: &HeaderMap) -> bool {
    if headers.contains_key("cf-ray") || headers.contains_key("cf-connecting-ip") {
        return false;
    }
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let host = host.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map_or(host, |(h, _)| h);
    LOOPBACK_HOSTS.contains(&host.to_ascii_lowercase().as_str())
}

#[derive(Clone, Default)]
struct Access {
    token: String,
    required: bool,
}

struct Shared {
    feed: broadcast::Sender<String>,
    settings: RwLock<Value>,
    fonts_dir: PathBuf,
    access: RwLock<Access>,
    /// Bumped whenever the key changes, so open sockets re-check theirs.
    access_gen: watch::Sender<u64>,
    failures: Mutex<HashMap<String, (u32, Instant)>>,
    local: AtomicU32,
    remote: AtomicU32,
    on_clients: Box<dyn Fn(u32, u32) + Send + Sync>,
}

impl Shared {
    fn counts_changed(&self) {
        (self.on_clients)(self.local.load(Ordering::SeqCst), self.remote.load(Ordering::SeqCst));
    }

    /// Who a failed attempt is attributed to. Behind the tunnel every request
    /// comes from 127.0.0.1; Cloudflare stamps `cf-connecting-ip` at its edge,
    /// the only identity a remote caller cannot choose.
    fn client_key(headers: &HeaderMap, addr: SocketAddr) -> String {
        headers
            .get("cf-connecting-ip")
            .and_then(|h| h.to_str().ok())
            .map(str::to_string)
            .unwrap_or_else(|| addr.ip().to_string())
    }

    fn throttled(&self, who: &str) -> bool {
        let failures = self.failures.lock().unwrap();
        failures.get(who).is_some_and(|(n, reset)| Instant::now() < *reset && *n >= RATE_MAX_FAILURES)
    }

    fn note_failure(&self, who: &str) {
        let now = Instant::now();
        let mut failures = self.failures.lock().unwrap();
        // A scan from many addresses must not grow this without bound.
        if failures.len() > 1000 {
            failures.retain(|_, (_, reset)| now < *reset);
        }
        let rec = failures.entry(who.to_string()).or_insert((0, now + RATE_WINDOW));
        if now >= rec.1 {
            *rec = (0, now + RATE_WINDOW);
        }
        rec.0 += 1;
    }

    fn authorized(&self, local: bool, key: &str) -> bool {
        let access = self.access.read().unwrap();
        !access.required || local || key_matches(key, &access.token)
    }
}

/// Emits client counts through `on_clients` whenever an overlay connects or
/// leaves. A local one is, in practice, OBS — which is how the app can say
/// "OBS connected" without asking.
pub struct CaptionServer {
    shared: Arc<Shared>,
    running: Mutex<Option<(u16, oneshot::Sender<()>)>>,
}

impl CaptionServer {
    pub fn new(fonts_dir: PathBuf, on_clients: impl Fn(u32, u32) + Send + Sync + 'static) -> Self {
        Self {
            shared: Arc::new(Shared {
                feed: broadcast::channel(256).0,
                settings: RwLock::new(json!({ "overlay": {}, "fonts": [] })),
                fonts_dir,
                access: RwLock::new(Access::default()),
                access_gen: watch::channel(0).0,
                failures: Mutex::new(HashMap::new()),
                local: AtomicU32::new(0),
                remote: AtomicU32::new(0),
                on_clients: Box::new(on_clients),
            }),
            running: Mutex::new(None),
        }
    }

    pub fn port(&self) -> Option<u16> {
        self.running.lock().unwrap().as_ref().map(|(p, _)| *p)
    }

    pub fn urls(&self, host: &str) -> Value {
        match self.port() {
            None => json!({ "overlay": null }),
            Some(p) => {
                let h = if host == "0.0.0.0" { "127.0.0.1" } else { host };
                json!({ "overlay": format!("http://{h}:{p}/overlay") })
            }
        }
    }

    pub fn counts(&self) -> (u32, u32) {
        (self.shared.local.load(Ordering::SeqCst), self.shared.remote.load(Ordering::SeqCst))
    }

    /// The link a remote viewer pastes into OBS: public origin plus key.
    pub fn share_url(&self, origin: &str) -> Option<String> {
        let access = self.shared.access.read().unwrap();
        if origin.is_empty() || access.token.is_empty() {
            return None;
        }
        Some(format!("{}/overlay?{KEY_PARAM}={}", origin.trim_end_matches('/'), access.token))
    }

    /// Arm or disarm the access gate. With sharing off the server is loopback
    /// only and demanding a key would just break existing OBS sources, so the
    /// gate is genuinely off rather than merely unused. Rotating the key cuts
    /// off whoever held the old one at once.
    pub fn set_access(&self, token: &str, required: bool) {
        *self.shared.access.write().unwrap() =
            Access { token: token.to_string(), required: required && !token.is_empty() };
        self.shared.failures.lock().unwrap().clear();
        self.shared.access_gen.send_modify(|g| *g += 1);
    }

    pub async fn start(&self, host: &str, port: u16) -> Result<Value, String> {
        let listener = tokio::net::TcpListener::bind((host, port)).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                format!("Port {port} is already in use. Pick a different port in ChatterLayer's settings.")
            } else {
                e.to_string()
            }
        })?;
        let bound = listener.local_addr().map_err(|e| e.to_string())?.port();
        let (stop, stopped) = oneshot::channel::<()>();
        let app = Router::new()
            .route("/", get(root))
            .route("/overlay", get(page))
            .route("/overlay.html", get(page))
            .route("/fonts/{file}", get(font))
            .fallback(|| async { (StatusCode::NOT_FOUND, "Not found") })
            .with_state(self.shared.clone());
        tokio::spawn(async move {
            let serve = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                });
            if let Err(e) = serve.await {
                eprintln!("[chatterlayer] caption server stopped: {e}");
            }
        });
        *self.running.lock().unwrap() = Some((bound, stop));
        Ok(self.urls(host))
    }

    pub async fn stop(&self) {
        let running = self.running.lock().unwrap().take();
        if let Some((_, stop)) = running {
            let _ = self.shared.feed.send(CLOSE.to_string());
            let _ = stop.send(());
        }
    }

    pub fn broadcast(&self, msg: &Value) {
        let _ = self.shared.feed.send(msg.to_string());
    }

    pub fn send_caption(&self, caption: &Value) {
        let mut msg = caption.clone();
        msg["type"] = json!("caption");
        self.broadcast(&msg);
    }

    /// Push styling changes live — no OBS refresh needed. The fonts folder is
    /// re-read each time, so a font dropped in shows up with the next change.
    pub fn update_settings(&self, settings: Value) {
        let merged = {
            let mut current = self.shared.settings.write().unwrap();
            if let (Value::Object(cur), Value::Object(new)) = (&mut *current, settings) {
                cur.extend(new);
            }
            current["fonts"] = json!(font_files(&self.shared.fonts_dir));
            current.clone()
        };
        self.broadcast(&json!({ "type": "settings", "settings": merged }));
    }

    /// Re-read the fonts folder, telling open overlays only if it changed.
    pub fn refresh_fonts(&self) -> Vec<String> {
        let fonts = font_files(&self.shared.fonts_dir);
        if self.shared.settings.read().unwrap()["fonts"] != json!(fonts) {
            self.update_settings(json!({}));
        }
        fonts
    }

    pub fn clear_captions(&self) {
        self.broadcast(&json!({ "type": "clear" }));
    }
}

/// Sent down the feed to make every socket close as the server stops.
const CLOSE: &str = "\u{0}close";

#[derive(serde::Deserialize)]
struct KeyQuery {
    k: Option<String>,
    /// The app's own style preview, which must not light "OBS connected".
    preview: Option<String>,
}

/// Gate shared by the page and the socket: throttle, then key, then (for
/// sockets) the remote viewer ceiling.
fn gate(shared: &Shared, headers: &HeaderMap, addr: SocketAddr, key: &str) -> Result<bool, Response> {
    let required = shared.access.read().unwrap().required;
    let who = Shared::client_key(headers, addr);
    if required && shared.throttled(&who) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, RATE_WINDOW.as_secs().to_string())],
            "429 — too many failed attempts. Try again shortly.",
        )
            .into_response());
    }
    let local = is_local(headers);
    if !shared.authorized(local, key) {
        shared.note_failure(&who);
        // Deliberately plain and non-specific: this page is reachable by
        // anyone who guesses the tunnel hostname.
        return Err((StatusCode::UNAUTHORIZED, "401 — this ChatterLayer overlay link needs a valid access key.")
            .into_response());
    }
    // A correct key clears the slate, so one fat-fingered paste doesn't leave
    // a co-streamer throttled for the next minute.
    if required {
        shared.failures.lock().unwrap().remove(&who);
    }
    Ok(local)
}

async fn root(
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    State(shared): State<Arc<Shared>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<KeyQuery>,
) -> Response {
    let key = q.k.unwrap_or_default();
    let counted = q.preview.is_none();
    let local = match gate(&shared, &headers, addr, &key) {
        Ok(local) => local,
        Err(denied) => return denied,
    };
    let Ok(ws) = ws else { return overlay() };
    if !local && shared.remote.load(Ordering::SeqCst) >= MAX_REMOTE_CLIENTS {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    ws.max_message_size(MAX_PAYLOAD_BYTES)
        .max_frame_size(MAX_PAYLOAD_BYTES)
        .on_upgrade(move |socket| client(socket, shared, local, key, counted))
}

async fn page(
    State(shared): State<Arc<Shared>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<KeyQuery>,
) -> Response {
    match gate(&shared, &headers, addr, &q.k.unwrap_or_default()) {
        Ok(_) => overlay(),
        Err(denied) => denied,
    }
}

/// A file from the fonts folder, behind the same gate as the page.
async fn font(
    State(shared): State<Arc<Shared>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    UrlPath(file): UrlPath<String>,
    Query(q): Query<KeyQuery>,
) -> Response {
    if let Err(denied) = gate(&shared, &headers, addr, &q.k.unwrap_or_default()) {
        return denied;
    }
    let (Some(kind), true) = (font_type(&file), font_files(&shared.fonts_dir).contains(&file)) else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    match tokio::fs::read(shared.fonts_dir.join(&file)).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, "no-cache")], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

fn overlay() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            // Overlay pages are reloaded constantly while tweaking; never cache.
            (header::CACHE_CONTROL, "no-store"),
        ],
        OVERLAY_HTML,
    )
        .into_response()
}

async fn client(mut socket: WebSocket, shared: Arc<Shared>, local: bool, key: String, counted: bool) {
    let counter = if local { &shared.local } else { &shared.remote };
    if counted {
        counter.fetch_add(1, Ordering::SeqCst);
        shared.counts_changed();
    }

    let mut feed = shared.feed.subscribe();
    let mut access = shared.access_gen.subscribe();
    // Current styling, so the overlay renders correctly straight away.
    // Deliberately NO caption backlog: OBS reloads the browser source on scene
    // changes, and replaying old speech would put words back on stream seconds
    // after they were said.
    let hello = json!({ "type": "hello", "settings": *shared.settings.read().unwrap() }).to_string();
    if socket.send(Message::Text(hello.into())).await.is_ok() {
        loop {
            tokio::select! {
                msg = feed.recv() => match msg {
                    Ok(text) if text == CLOSE => {
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    // A viewer too slow to keep up misses captions, not the feed.
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                changed = access.changed() => {
                    if changed.is_err() || !shared.authorized(local, &key) {
                        let frame = CloseFrame { code: 4401, reason: "Access key no longer valid".into() };
                        let _ = socket.send(Message::Close(Some(frame))).await;
                        break;
                    }
                }
                // The feed is strictly one-directional: a connected overlay is
                // a viewer, never a controller, and nothing it sends is read.
                // Anything that changes that turns a read-only link into a
                // control channel handed out to co-streamers — don't.
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                },
            }
        }
    }
    if counted {
        counter.fetch_sub(1, Ordering::SeqCst);
        shared.counts_changed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_hosts() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "127.0.0.1:8777".parse().unwrap());
        assert!(is_local(&h));
        h.insert(header::HOST, "abc.trycloudflare.com".parse().unwrap());
        assert!(!is_local(&h));
        h.insert(header::HOST, "localhost:8777".parse().unwrap());
        h.insert("cf-ray", "x".parse().unwrap());
        assert!(!is_local(&h));
    }

    #[test]
    fn only_font_files_are_listed() {
        let dir = std::env::temp_dir().join(format!("chatterlayer-fonts-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub.ttf")).unwrap();
        for name in ["Bangers.TTF", "a.woff2", "notes.txt", "font.ttf.exe"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        assert_eq!(font_files(&dir), ["a.woff2", "Bangers.TTF"]);
        assert_eq!(font_type("x.WOFF2"), Some("font/woff2"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keys() {
        let k = new_access_key();
        assert_eq!(k.len(), 22);
        assert!(key_matches(&k, &k));
        assert!(!key_matches("nope", &k));
        assert!(!key_matches("", ""));
    }
}
