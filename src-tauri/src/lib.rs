//! Owns the window, config, caption server and Discord engine, and passes
//! messages between them.
//!
//! Colours and display names are resolved here rather than in the engine,
//! which only knows who said what. Renaming or recolouring a speaker applies to
//! the next caption without disturbing the Discord connection.

mod colors;
mod config;
mod discord;
mod install;
mod meta;
mod mic;
mod models;
mod server;
mod stt;
mod tunnel;
mod wordfilter;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Theme, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{ManagerExt as AutostartExt, MacosLauncher};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use config::Config;
use discord::Engine;
use server::CaptionServer;
use tunnel::{Tunnel, TunnelEvent};
use wordfilter::Filter;

/// Passed by "start with the computer": come up in the tray only.
const HIDDEN: &str = "--hidden";
/// WidgetCake stops the app by launching it again with this.
const QUIT: &str = "--quit";

/// Lines for "Send test caption", taken in turn. Different lengths on purpose:
/// pressing it a few times shows wrapping and Max lines.
const TEST_LINES: [&str; 3] = [
    "This is a test caption from ChatterLayer.",
    "Captions wrap like this when somebody keeps talking for a while without stopping for breath.",
    "Size and place the browser source in OBS until this looks right.",
];

struct App {
    config: Mutex<Config>,
    server: CaptionServer,
    engine: Engine,
    tunnel: Tunnel,
    models_dir: PathBuf,
    /// Fonts the overlay can use without them being installed on every PC.
    fonts_dir: PathBuf,
    /// Latest sign-in state and server/channel tree, so the window gets them
    /// whether it subscribed before or after they arrived.
    discord: Mutex<Value>,
    /// Pause: still in the call, still transcribing, but nothing goes out.
    /// Never saved, so a fresh launch is never silently paused.
    paused: AtomicBool,
    filter: RwLock<Filter>,
    masked_total: AtomicUsize,
    /// Collision-free colours for everyone in the call, recomputed whenever
    /// the members or the overrides change.
    colors: Mutex<HashMap<String, String>>,
    /// The tally lamp's state for the tray, and how many people are on.
    tray_status: Mutex<(&'static str, usize)>,
    test_line: AtomicUsize,
    /// Decided once at launch; null when there's nothing to announce.
    whats_new: Mutex<Value>,
    /// The live tunnel's access key, kept out of bug reports.
    share_key: Mutex<String>,
    /// Captions have been going out, so them stopping is news.
    captions_live: AtomicBool,
    /// A stop was announced, so the recovery is worth announcing too.
    told_stopped: AtomicBool,
    /// Models being fetched right now.
    downloading: Mutex<std::collections::HashSet<String>>,
    /// Set once quitting has started, so closing the window really closes.
    quitting: AtomicBool,
}

type Shared<'a> = tauri::State<'a, Arc<App>>;

impl App {
    fn rebuild_filter(&self) {
        let cfg = self.config.lock().unwrap();
        let custom: Vec<String> = cfg
            .get("/filter/custom")
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        *self.filter.write().unwrap() = Filter::new(cfg.get("/filter/enabled").as_bool().unwrap_or(true), &custom);
    }

    fn caption_name(&self, user_id: &str, fallback: &str) -> String {
        let cfg = self.config.lock().unwrap();
        match cfg.get(&format!("/aliases/{user_id}")).as_str().map(str::trim) {
            Some(alias) if !alias.is_empty() => alias.to_string(),
            _ => fallback.to_string(),
        }
    }

    fn color_overrides(&self) -> HashMap<String, String> {
        serde_json::from_value(self.config.lock().unwrap().get("/colors").clone()).unwrap_or_default()
    }

    fn caption_color(&self, user_id: &str) -> String {
        if let Some(c) = self.colors.lock().unwrap().get(user_id) {
            return c.clone();
        }
        colors::color_for_user(user_id, &self.color_overrides())
    }

    /// Everything the window needs to draw the sharing panel.
    fn share_state(&self) -> Value {
        let enabled = self.config.lock().unwrap().get("/share/enabled") == true;
        let origin = self.tunnel.url();
        let url = if origin.is_empty() { None } else { self.server.share_url(&origin) };
        json!({
            "enabled": enabled, "running": !origin.is_empty(), "busy": self.tunnel.starting(),
            "origin": origin, "url": url.unwrap_or_default(),
        })
    }
}

fn send(app: &AppHandle, channel: &str, payload: Value) {
    let _ = app.emit(channel, payload);
}

fn log(app: &AppHandle, level: &str, message: impl Into<String>) {
    send(app, "chatterlayer:event", json!({ "type": "log", "level": level, "message": message.into() }));
}

/// Everything that goes on stream is resolved here: colour, display name and
/// slur masking. Filtering at this single point means unmasked text never
/// reaches the overlay or the monitor — test captions included.
fn deliver_caption(app: &AppHandle, state: &App, user_id: &str, username: &str, text: &str, is_final: bool, timestamp: Value) {
    if state.paused.load(Ordering::SeqCst) {
        return;
    }
    let filter = state.filter.read().unwrap();
    let (body, masked_body) = filter.mask(text);
    // A slur can just as easily be in someone's Discord name.
    let (name, masked_name) = filter.mask(&state.caption_name(user_id, username));
    drop(filter);
    let caption = json!({
        "userId": user_id, "username": name, "text": body,
        "color": state.caption_color(user_id), "isFinal": is_final, "timestamp": timestamp,
    });
    state.server.send_caption(&caption);
    send(app, "chatterlayer:caption", caption);
    if is_final && masked_body + masked_name > 0 {
        let total = state.masked_total.fetch_add(masked_body + masked_name, Ordering::SeqCst) + masked_body + masked_name;
        send(app, "chatterlayer:event", json!({ "type": "filter", "masked": total }));
    }
}

fn wipe_captions(app: &AppHandle, state: &App) {
    state.server.clear_captions();
    send(app, "chatterlayer:event", json!({ "type": "cleared" }));
}

fn set_paused_inner(app: &AppHandle, state: &App, on: bool) {
    state.paused.store(on, Ordering::SeqCst);
    // A panic button that left the last sentence on screen would not be one.
    if on {
        wipe_captions(app, state);
    }
    send(app, "chatterlayer:event", json!({ "type": "paused", "paused": on }));
    render_tray(app);
}

/// The engine's messages, on their way to the overlay, the window and the tray.
fn relay(app: &AppHandle, msg: Value) {
    let Some(state) = app.try_state::<Arc<App>>() else { return };
    let kind = msg["type"].as_str().unwrap_or("").to_string();
    match kind.as_str() {
        "caption" => deliver_caption(
            app,
            &state,
            msg["userId"].as_str().unwrap_or(""),
            msg["username"].as_str().unwrap_or(""),
            msg["text"].as_str().unwrap_or(""),
            msg["isFinal"].as_bool().unwrap_or(false),
            msg["timestamp"].clone(),
        ),
        "captionCleared" => {
            state.server.broadcast(&json!({ "type": "captionCleared", "userId": msg["userId"] }));
            // The monitor mirrors the overlay, so it has to hear this too.
            send(app, "chatterlayer:event", msg);
        }
        "members" => {
            let members = msg["members"].as_array().cloned().unwrap_or_default();
            let overrides = state.color_overrides();
            // Re-derive colours across the whole call so nobody shares one.
            let assigned = colors::assign_colors(members.iter().filter_map(|m| m["id"].as_str()), &overrides);
            let aliases = state.config.lock().unwrap().get("/aliases").clone();
            let enriched: Vec<Value> = members
                .into_iter()
                .map(|mut m| {
                    let id = m["id"].as_str().unwrap_or("").to_string();
                    let display = m["displayName"].as_str().unwrap_or("").to_string();
                    m["alias"] = json!(aliases[&id].as_str().unwrap_or(""));
                    m["captionName"] = json!(state.caption_name(&id, &display));
                    m["color"] = json!(assigned.get(&id));
                    m["customColor"] = json!(overrides.contains_key(&id));
                    m
                })
                .collect();
            let on = enriched.iter().filter(|m| m["selected"] == true).count();
            *state.colors.lock().unwrap() = assigned;
            send(app, "chatterlayer:members", json!(enriched));
            state.tray_status.lock().unwrap().1 = on;
            render_tray(app);
        }
        "auth" => {
            {
                let mut d = state.discord.lock().unwrap();
                let gone = msg["state"] == "error" || msg["state"] == "signed-out";
                let keep = |field: &str| if gone { Value::Null } else if msg[field].is_null() { d[field].clone() } else { msg[field].clone() };
                *d = json!({
                    "auth": msg["state"],
                    "message": msg["message"].as_str().unwrap_or(""),
                    "botTag": keep("botTag"),
                    "botId": keep("botId"),
                    // Nothing to pick from once the session is gone.
                    "guilds": if gone { json!([]) } else { d["guilds"].clone() },
                });
            }
            send(app, "chatterlayer:event", msg);
        }
        "guilds" => {
            {
                let mut d = state.discord.lock().unwrap();
                d["guilds"] = msg["guilds"].clone();
                d["botTag"] = msg["botTag"].clone();
                d["botId"] = msg["botId"].clone();
            }
            send(app, "chatterlayer:event", msg);
        }
        "status" => {
            // The same lamp states the window shows, so the tray never
            // disagrees with the tally someone was looking at.
            {
                let mut t = state.tray_status.lock().unwrap();
                match msg["state"].as_str().unwrap_or("") {
                    "joined" => t.0 = "onair",
                    "error" => t.0 = "fault",
                    "stopped" | "disconnected" => *t = ("standby", 0),
                    _ => t.0 = "linking",
                }
            }
            notice_status(app, &state, &msg);
            render_tray(app);
            send(app, "chatterlayer:event", msg);
        }
        _ => send(app, "chatterlayer:event", msg),
    }
}

// ------------------------------------------------------------------ tray ---

fn status_label(state: &App) -> String {
    let (lamp, speakers) = *state.tray_status.lock().unwrap();
    match lamp {
        "onair" if state.paused.load(Ordering::SeqCst) => "Paused — nothing is going out".into(),
        "onair" if speakers > 0 => format!("On air — {speakers} on"),
        "onair" => "On air — nobody switched on".into(),
        "linking" => "Connecting…".into(),
        "fault" => "Fault — open the window".into(),
        _ => "Standby".into(),
    }
}

/// ChatterLayer runs for as long as the stream does, and for most of that
/// time nobody needs to look at it, so the tray carries status, Pause,
/// Disconnect and Quit.
fn render_tray(app: &AppHandle) {
    let (Some(state), Some(tray)) = (app.try_state::<Arc<App>>(), app.tray_by_id("tray")) else { return };
    let label = status_label(&state);
    let running = matches!(state.tray_status.lock().unwrap().0, "onair" | "linking");
    let paused = state.paused.load(Ordering::SeqCst);
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let status = MenuItem::with_id(app, "status", &label, false, None::<&str>)?;
        let show = MenuItem::with_id(app, "show", "Show ChatterLayer", true, None::<&str>)?;
        let pause = MenuItem::with_id(app, "pause", if paused { "Resume captions" } else { "Pause captions" }, running, None::<&str>)?;
        let stop = MenuItem::with_id(app, "disconnect", "Disconnect", running, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit ChatterLayer", true, None::<&str>)?;
        let sep = || PredefinedMenuItem::separator(app);
        Menu::with_items(app, &[&status, &sep()?, &show, &pause, &stop, &sep()?, &quit])
    };
    if let Ok(menu) = build() {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_tooltip(Some(format!("ChatterLayer — {label}")));
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id("tray")
        .icon(app.default_window_icon().cloned().expect("the app icon"))
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "pause" => {
                let state = app.state::<Arc<App>>();
                let on = !state.paused.load(Ordering::SeqCst);
                set_paused_inner(app, &state, on);
            }
            "disconnect" => {
                let engine = app.state::<Arc<App>>().engine.clone();
                tauri::async_runtime::spawn(async move { engine.leave(true).await });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        // Left click is "show me", which is what people try first.
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    render_tray(app);
    Ok(())
}

// --------------------------------------------------------------- hotkeys ---

/// System-wide, because the moment you need them the game has focus. Off by
/// default: a global shortcut quietly steals that key from every other app.
const HOTKEY_PAUSE: &str = "CommandOrControl+Alt+P";
const HOTKEY_CLEAR: &str = "CommandOrControl+Alt+K";

fn apply_hotkeys(app: &AppHandle) {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let state = app.state::<Arc<App>>();
    if state.config.lock().unwrap().get("/hotkeys/enabled") != true {
        return;
    }
    let ctrl = if cfg!(target_os = "macos") { "Cmd" } else { "Ctrl" };
    let taken: Vec<String> = [(HOTKEY_PAUSE, "P"), (HOTKEY_CLEAR, "K")]
        .iter()
        .filter(|(accel, _)| shortcuts.register(*accel).is_err())
        .map(|(_, key)| format!("{ctrl}+Alt+{key}"))
        .collect();
    if !taken.is_empty() {
        let one = taken.len() == 1;
        log(app, "warn", format!(
            "{} {} already taken by another app, so {} nothing here.",
            taken.join(" and "),
            if one { "is" } else { "are" },
            if one { "it does" } else { "they do" }
        ));
    }
}

fn on_hotkey(app: &AppHandle, shortcut: &tauri_plugin_global_shortcut::Shortcut) {
    let state = app.state::<Arc<App>>();
    if HOTKEY_PAUSE.parse::<tauri_plugin_global_shortcut::Shortcut>().is_ok_and(|p| &p == shortcut) {
        let on = !state.paused.load(Ordering::SeqCst);
        set_paused_inner(app, &state, on);
    } else {
        wipe_captions(app, &state);
    }
}

/// Start with the computer, straight into the tray. Only the Discord sign-in
/// happens on its own, as on any launch; nobody is captioned until Connect.
fn apply_login_item(app: &AppHandle) {
    let on = app.state::<Arc<App>>().config.lock().unwrap().get("/startup/atLogin") == true;
    let autostart = app.autolaunch();
    let _ = if on { autostart.enable() } else { autostart.disable() };
}

// ---------------------------------------------------------- notifications ---

/// Not looking at the window — which, mid-stream, is nearly always.
fn away(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_none_or(|w| {
        !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) || !w.is_focused().unwrap_or(false)
    })
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Say so when captions stop on their own and nobody is watching the app.
fn notice_status(app: &AppHandle, state: &App, msg: &Value) {
    let message = msg["message"].as_str().unwrap_or("");
    match msg["state"].as_str().unwrap_or("") {
        "joined" => {
            if state.told_stopped.swap(false, Ordering::SeqCst) && away(app) {
                notify(app, "Captions are back", message);
            }
            state.captions_live.store(true, Ordering::SeqCst);
        }
        // The user's own Disconnect.
        "stopped" => {
            state.captions_live.store(false, Ordering::SeqCst);
            state.told_stopped.store(false, Ordering::SeqCst);
        }
        "error" | "disconnected" if state.captions_live.swap(false, Ordering::SeqCst) => {
            if away(app) {
                notify(app, "Captions stopped", message);
                state.told_stopped.store(true, Ordering::SeqCst);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- window ---

fn theme(state: &App) -> Option<Theme> {
    match state.config.lock().unwrap().str("/appearance/theme") {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

/// The stylesheet reads prefers-color-scheme, which follows the window's
/// theme — so one call switches the whole window, live, and "Match system"
/// keeps following Windows after that.
fn apply_theme(app: &AppHandle) {
    let state = app.state::<Arc<App>>();
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(theme(&state));
    }
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let state = app.state::<Arc<App>>();
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("ChatterLayer")
        .inner_size(1240.0, 860.0)
        .min_inner_size(980.0, 640.0)
        // The page draws its own title bar, like WidgetCake's.
        .decorations(false)
        .theme(theme(&state))
        .build();
    match built {
        Ok(w) => limit_permissions(&w),
        Err(e) => eprintln!("[chatterlayer] could not open the window: {e}"),
    }
}

/// The window may have the microphone and nothing else — no camera, no
/// screen, no location. WebView2 otherwise asks every time and forgets the
/// answer, and until a grant is remembered it hides the mics' names too.
#[cfg(windows)]
fn limit_permissions(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        COREWEBVIEW2_PERMISSION_STATE_DENY, ICoreWebView2PermissionRequestedEventArgs3,
    };
    use webview2_com::PermissionRequestedEventHandler;
    use windows::core::Interface;

    let page = window.clone();
    let _ = window.with_webview(move |webview| {
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            // SAFETY: COM calls on the event's own arguments, on its thread.
            unsafe {
                args.PermissionKind(&mut kind)?;
                let mic = kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE;
                args.SetState(if mic { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY })?;
                if let Ok(args) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    args.SetSavesInProfile(mic)?;
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: the controller belongs to this live webview.
        unsafe {
            if let Ok(core) = webview.controller().CoreWebView2() {
                let _ = core.add_PermissionRequested(&handler, &mut token);
                grant_microphone(&core, page.clone());
            }
        }
    });
}

/// Granted up front, for this page's own origin, so the mic picker shows real
/// device names from the first launch — browsers hide them until access is
/// granted — without opening the mic just to read them.
#[cfg(windows)]
unsafe fn grant_microphone(core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2, page: tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW, ICoreWebView2_13, ICoreWebView2Profile4,
    };
    use webview2_com::SetPermissionStateCompletedHandler;
    use windows::core::{Interface, PCWSTR};

    // Where Tauri serves the app on Windows. Read from the window instead,
    // this is "null": the grant is made before the page has loaded.
    let wide: Vec<u16> = "http://tauri.localhost".encode_utf16().chain([0]).collect();
    // SAFETY: COM calls on a live webview; `wide` outlives the call.
    unsafe {
        let Ok(profile) = core.cast::<ICoreWebView2_13>().and_then(|c| c.Profile()).and_then(|p| p.cast::<ICoreWebView2Profile4>()) else {
            return;
        };
        let done = SetPermissionStateCompletedHandler::create(Box::new(move |_| {
            // The picker may already have been filled with numbered entries.
            let _ = page.eval("typeof renderMics === 'function' && renderMics()");
            Ok(())
        }));
        let _ = profile.SetPermissionState(
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            PCWSTR(wide.as_ptr()),
            COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            &done,
        );
    }
}

#[cfg(not(windows))]
fn limit_permissions(_window: &tauri::WebviewWindow) {}

// -------------------------------------------------------------- commands ---

#[tauri::command]
fn get_state(state: Shared) -> Value {
    // Before the config lock below: it takes that lock itself.
    let share = state.share_state();
    let cfg = state.config.lock().unwrap();
    let models = models::list(&state.models_dir);
    let model_path = models::resolve(&state.models_dir, cfg.str("/modelPath")).ok().map(|m| m.path);
    let (local, remote) = state.server.counts();
    let platform = if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    let ctrl = if cfg!(target_os = "macos") { "Cmd" } else { "Ctrl" };
    json!({
        "config": cfg.to_client(),
        "palette": colors::PALETTE,
        "urls": state.server.urls(cfg.str("/server/host")),
        "port": state.server.port(),
        "modelPath": model_path,
        "models": models,
        "running": state.engine.running(),
        "discord": *state.discord.lock().unwrap(),
        "share": share,
        "overlays": { "local": local, "remote": remote },
        "whatsNew": *state.whats_new.lock().unwrap(),
        "paused": state.paused.load(Ordering::SeqCst),
        "platform": platform,
        "hotkeys": { "pause": format!("{ctrl}+Alt+P"), "clear": format!("{ctrl}+Alt+K") },
        "version": env!("CARGO_PKG_VERSION"),
        "releasesUrl": meta::RELEASES_PAGE,
    })
}

#[tauri::command]
async fn update_config(app: AppHandle, state: Shared<'_>, patch: Value) -> Result<Value, String> {
    let before = state.config.lock().unwrap().get("/server").clone();
    state.config.lock().unwrap().update(patch.clone());

    // Overlay styling is live-pushed to the connected browser source.
    if !patch["overlay"].is_null() {
        let overlay = state.config.lock().unwrap().get("/overlay").clone();
        state.server.update_settings(json!({ "overlay": overlay }));
    }
    if !patch["filter"].is_null() {
        state.rebuild_filter();
    }
    if !patch["mic"].is_null() {
        apply_mic_gate(&state);
    }
    if !patch["appearance"].is_null() {
        apply_theme(&app);
    }
    if !patch["hotkeys"].is_null() {
        apply_hotkeys(&app);
    }
    if !patch["startup"].is_null() {
        apply_login_item(&app);
    }

    // Changing host or port needs the server rebound.
    let (after, overlay) = {
        let cfg = state.config.lock().unwrap();
        (cfg.get("/server").clone(), cfg.get("/overlay").clone())
    };
    if after != before {
        // A live tunnel points at the old port and can't survive this. Taking
        // it down beats leaving a link that resolves to nothing.
        if state.tunnel.running() {
            stop_sharing(&app, &state).await;
            log(&app, "warn", "Port changed — remote sharing stopped. Start it again for a new link.");
        }
        state.server.stop().await;
        start_server(&app, &state, &after).await;
        state.server.update_settings(json!({ "overlay": overlay }));
    }
    Ok(state.config.lock().unwrap().to_client())
}

async fn start_server(app: &AppHandle, state: &App, server: &Value) {
    let host = server["host"].as_str().unwrap_or("127.0.0.1");
    let port = server["port"].as_u64().unwrap_or(8777) as u16;
    match state.server.start(host, port).await {
        Ok(urls) => send(app, "chatterlayer:event", json!({ "type": "server", "state": "ready", "urls": urls, "port": state.server.port() })),
        Err(message) => send(app, "chatterlayer:event", json!({ "type": "server", "state": "error", "message": message })),
    }
}

#[tauri::command]
fn set_token(state: Shared, token: String) -> Value {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_token(&token);
    cfg.to_client()
}

/// Sign in, or refresh the channel list if already signed in on this token.
#[tauri::command]
fn sign_in(state: Shared, token: Option<String>) -> Result<bool, String> {
    let active = {
        let mut cfg = state.config.lock().unwrap();
        if let Some(t) = token.filter(|t| !t.is_empty()) {
            cfg.set_token(&t);
        }
        cfg.token().to_string()
    };
    if active.is_empty() {
        return Err("Enter your Discord bot token first.".into());
    }
    let engine = state.engine.clone();
    // A failed sign-in reports itself as an `auth` event; it is not a fault.
    tauri::async_runtime::spawn(async move {
        let _ = engine.sign_in(&active).await;
    });
    Ok(true)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartOpts {
    token: Option<String>,
    channel_id: Option<String>,
    guild_id: Option<String>,
}

#[tauri::command]
fn start(app: AppHandle, state: Shared, opts: StartOpts) -> Result<bool, String> {
    let (token, channel, model, source, selected, follow, me) = {
        let mut cfg = state.config.lock().unwrap();
        if let Some(t) = opts.token.filter(|t| !t.is_empty()) {
            cfg.set_token(&t);
        }
        if let Some(c) = opts.channel_id {
            cfg.update(json!({ "channelId": c }));
        }
        if let Some(g) = opts.guild_id {
            cfg.update(json!({ "guildId": g }));
        }
        let selected: Vec<String> = serde_json::from_value(cfg.get("/selected").clone()).unwrap_or_default();
        (
            cfg.token().to_string(),
            cfg.str("/channelId").to_string(),
            cfg.str("/modelPath").to_string(),
            cfg.str("/source").to_string(),
            selected,
            Some(cfg.str("/follow/userId").to_string()).filter(|s| !s.is_empty()),
            Some(cfg.str("/me/userId").to_string()).filter(|s| !s.is_empty()),
        )
    };
    if source != "mic" {
        if token.is_empty() {
            return Err("Enter your Discord bot token first.".into());
        }
        if channel.is_empty() {
            return Err("Pick a voice channel first.".into());
        }
    }
    // Before start, so the mic's gate is tuned from its first chunk and the
    // streamer's Discord audio is never captured beside their mic.
    apply_mic_gate(&state);
    let engine = state.engine.clone();
    engine.set_me(me);
    engine.set_follow(follow);
    tauri::async_runtime::spawn(async move {
        match engine.start(Some(&token), &channel, &model, &source).await {
            // Restore the previous selection now the call is up.
            Ok(()) => engine.set_selected(selected),
            Err(message) => {
                relay(&app, json!({ "type": "status", "state": "error", "message": message }));
                log(&app, "error", message);
            }
        }
    });
    Ok(true)
}

#[tauri::command]
async fn stop(state: Shared<'_>) -> Result<bool, String> {
    state.engine.leave(true).await;
    Ok(true)
}

#[tauri::command]
fn mic_access() -> bool {
    true
}

/// Mic audio from the window, ten times a second, as a raw body rather than
/// JSON, which would turn every sample into a number in an array.
#[tauri::command]
fn mic_audio(state: Shared, request: tauri::ipc::Request) {
    if let tauri::ipc::InvokeBody::Raw(bytes) = request.body() {
        state.engine.mic_audio(bytes);
    }
}

fn apply_mic_gate(state: &App) {
    let (sensitivity, hang) = {
        let cfg = state.config.lock().unwrap();
        (cfg.get("/mic/sensitivity").as_f64().unwrap_or(5.0), cfg.get("/mic/hangMs").as_f64().unwrap_or(700.0))
    };
    state.engine.set_mic_gate(sensitivity, hang);
}

#[tauri::command]
fn set_selected(state: Shared, user_ids: Vec<String>) -> Vec<String> {
    state.config.lock().unwrap().update(json!({ "selected": user_ids }));
    state.engine.set_selected(user_ids.clone());
    user_ids
}

#[tauri::command]
fn set_color(state: Shared, user_id: String, color: Option<String>) -> Value {
    let client = {
        let mut cfg = state.config.lock().unwrap();
        let mut colors = cfg.get("/colors").clone();
        match color.filter(|c| !c.is_empty()) {
            Some(c) => colors[&user_id] = json!(c),
            // Back to the hashed default.
            None => {
                colors.as_object_mut().map(|o| o.remove(&user_id));
            }
        }
        cfg.update(json!({ "colors": colors }));
        cfg.to_client()
    };
    state.engine.emit_members();
    client
}

#[tauri::command]
fn set_alias(state: Shared, user_id: String, alias: String) -> Value {
    let client = {
        let mut cfg = state.config.lock().unwrap();
        let mut aliases = cfg.get("/aliases").clone();
        match alias.trim() {
            // Empty reverts to their Discord name.
            "" => {
                aliases.as_object_mut().map(|o| o.remove(&user_id));
            }
            a => aliases[&user_id] = json!(a),
        }
        cfg.update(json!({ "aliases": aliases }));
        cfg.to_client()
    };
    state.engine.emit_members();
    client
}

#[tauri::command]
fn clear_captions(app: AppHandle, state: Shared) -> bool {
    wipe_captions(&app, &state);
    true
}

/// A line on the overlay through exactly the path speech takes, so OBS can be
/// sized and positioned without anyone being in a call.
#[tauri::command]
fn test_caption(app: AppHandle, state: Shared) -> Value {
    let text = TEST_LINES[state.test_line.fetch_add(1, Ordering::SeqCst) % TEST_LINES.len()];
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    deliver_caption(&app, &state, "chatterlayer-test", "Test", text, true, json!(now));
    let (local, remote) = state.server.counts();
    json!({ "local": local, "remote": remote, "paused": state.paused.load(Ordering::SeqCst) })
}

#[tauri::command]
fn set_paused(app: AppHandle, state: Shared, on: bool) -> bool {
    set_paused_inner(&app, &state, on);
    on
}

/// Follow mode: whose channel moves the bot follows, or nobody. Saved, so it
/// holds across reconnects.
#[tauri::command]
fn set_follow(state: Shared, user_id: Option<String>) -> Value {
    let client = {
        let mut cfg = state.config.lock().unwrap();
        cfg.update(json!({ "follow": { "userId": user_id.clone().unwrap_or_default() } }));
        cfg.to_client()
    };
    state.engine.set_follow(user_id);
    client
}

/// "This is me": which Discord member is the streamer. Saved, like Follow.
#[tauri::command]
fn set_me(state: Shared, user_id: Option<String>) -> Value {
    let client = {
        let mut cfg = state.config.lock().unwrap();
        cfg.update(json!({ "me": { "userId": user_id.clone().unwrap_or_default() } }));
        cfg.to_client()
    };
    state.engine.set_me(user_id);
    client
}

/// Open a prefilled bug report in the browser. The window hands over the Log
/// panel as it reads; the token, the share key and anything shaped like a
/// token are stripped here, where the real secrets are known.
#[tauri::command]
fn report_problem(app: AppHandle, state: Shared, log: String) -> Result<(), String> {
    let installed = models::list(&state.models_dir);
    let model = {
        let cfg = state.config.lock().unwrap();
        // A custom model has no option on the form, so that field is left for them.
        match models::resolve(&state.models_dir, cfg.str("/modelPath")) {
            _ if installed.is_empty() => "No model downloaded yet".to_string(),
            Ok(m) => models::find_by_dir(&m.name).and_then(|e| e["label"].as_str()).unwrap_or("").to_string(),
            Err(_) => String::new(),
        }
    };
    let token = state.config.lock().unwrap().token().to_string();
    let key = state.share_key.lock().unwrap().clone();
    let url = meta::report_url(env!("CARGO_PKG_VERSION"), &model, &meta::scrub_log(&log, &[&token, &key]));
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn dismiss_whats_new(state: Shared) -> bool {
    *state.whats_new.lock().unwrap() = Value::Null;
    true
}

// -------------------------------------------------------- remote sharing ---
//
// The access key remote overlay links carry is minted per tunnel session and
// kept in memory only. 128 random bits in the URL is the whole authentication
// story, which suits what it protects: captions already going out on a public
// stream. It stops a scanned or stale hostname being enough to watch someone's
// voice channel. A Quick Tunnel's hostname changes every run anyway, so a saved
// key would buy nothing — and would be a live credential in a plain-text file.

fn send_share(app: &AppHandle, state: &App, extra: Value) {
    let mut msg = state.share_state();
    msg["type"] = json!("tunnel");
    if let (Value::Object(m), Value::Object(e)) = (&mut msg, extra) {
        m.extend(e);
    }
    send(app, "chatterlayer:event", msg);
}

/// Close the tunnel and disarm the access gate. Safe when already down.
async fn stop_sharing(app: &AppHandle, state: &App) {
    state.tunnel.stop().await;
    state.share_key.lock().unwrap().clear();
    state.server.set_access("", false);
    send_share(app, state, json!({}));
}

fn on_tunnel(app: &AppHandle, event: TunnelEvent) {
    let Some(state) = app.try_state::<Arc<App>>() else { return };
    match event {
        TunnelEvent::Status(progress) => {
            let phase = progress["phase"].clone();
            send_share(app, &state, json!({ "phase": phase, "progress": progress }));
        }
        // cloudflared died on its own. The gate comes down with it — left
        // armed, it would demand a key from the host's own OBS for no reason.
        TunnelEvent::Dropped(code) => {
            state.share_key.lock().unwrap().clear();
            state.server.set_access("", false);
            let code = code.map_or("?".to_string(), |c| c.to_string());
            send_share(app, &state, json!({
                "message": format!("The tunnel dropped (cloudflared exited, code {code}). Start it again to get a new link."),
                "level": "warn",
            }));
        }
    }
}

/// Arm or disarm the sharing panel. Switching it on deliberately does NOT
/// open a tunnel — that needs an explicit Start.
#[tauri::command]
async fn set_share_enabled(app: AppHandle, state: Shared<'_>, on: bool) -> Result<Value, String> {
    state.config.lock().unwrap().update(json!({ "share": { "enabled": on } }));
    if !on && state.tunnel.running() {
        stop_sharing(&app, &state).await;
    }
    Ok(state.share_state())
}

#[tauri::command]
async fn start_share(app: AppHandle, state: Shared<'_>) -> Result<Value, String> {
    if state.config.lock().unwrap().get("/share/enabled") != true {
        return Err("Turn on remote sharing first.".into());
    }
    if state.tunnel.running() {
        return Ok(state.share_state());
    }
    // Without a bound port cloudflared would happily point at a dead address
    // and hand out a link.
    let Some(port) = state.server.port() else {
        return Err("The caption server is not running — check the port setting.".into());
    };
    // A new key for every session, armed before the tunnel exists: there must
    // be no moment the overlay is reachable from the internet without one.
    let key = server::new_access_key();
    *state.share_key.lock().unwrap() = key.clone();
    state.server.set_access(&key, true);
    send_share(&app, &state, json!({ "busy": true }));
    match state.tunnel.start(port).await {
        Ok(origin) => {
            send_share(&app, &state, json!({ "origin": origin, "url": state.server.share_url(&origin) }));
            Ok(state.share_state())
        }
        Err(message) => {
            state.share_key.lock().unwrap().clear();
            state.server.set_access("", false);
            send_share(&app, &state, json!({ "message": message, "level": "error" }));
            Err(message)
        }
    }
}

#[tauri::command]
async fn stop_share(app: AppHandle, state: Shared<'_>) -> Result<Value, String> {
    stop_sharing(&app, &state).await;
    Ok(state.share_state())
}

/// A new key mid-session, invalidating every link already handed out; remote
/// viewers still holding the old one are dropped at once.
#[tauri::command]
fn rotate_share_token(app: AppHandle, state: Shared) -> Result<Value, String> {
    if state.tunnel.url().is_empty() {
        return Err("Start the tunnel before regenerating its key.".into());
    }
    let key = server::new_access_key();
    *state.share_key.lock().unwrap() = key.clone();
    state.server.set_access(&key, true);
    send_share(&app, &state, json!({ "message": "Access key regenerated — old links no longer work." }));
    Ok(state.share_state())
}

#[tauri::command]
fn model_catalog(state: Shared) -> Value {
    json!({
        "catalog": models::catalog_with_status(&state.models_dir),
        "installed": models::list(&state.models_dir),
        "modelsDir": state.models_dir.display().to_string(),
        // Worked out from the OS's own RAM and CPU figures, and never sent
        // anywhere.
        "suggestion": install::suggestion(),
    })
}

#[tauri::command]
async fn install_model(app: AppHandle, state: Shared<'_>, key: String) -> Result<Value, String> {
    // The same model can't be fetched twice at once.
    if !state.downloading.lock().unwrap().insert(key.clone()) {
        return Err("That model is already downloading.".into());
    }
    let progress_app = app.clone();
    let progress_key = key.clone();
    let progress = move |mut p: Value| {
        p["key"] = json!(progress_key);
        send(&progress_app, "chatterlayer:modelProgress", p);
    };
    let result = install::install(&key, &state.models_dir, &progress).await;
    state.downloading.lock().unwrap().remove(&key);
    match result {
        Ok(path) => {
            // The first model is selected straight away, so nobody is left
            // with a downloaded model and nothing using it.
            let mut cfg = state.config.lock().unwrap();
            if cfg.str("/modelPath").is_empty() {
                cfg.update(json!({ "modelPath": path.display().to_string() }));
            }
            drop(cfg);
            send(&app, "chatterlayer:modelProgress", json!({ "key": key, "phase": "done" }));
            let model = models::identify(&path);
            Ok(json!({ "ok": true, "name": model.as_ref().map(|m| &m.name), "path": path, "engine": model.as_ref().map(|m| &m.engine) }))
        }
        Err(message) => {
            send(&app, "chatterlayer:modelProgress", json!({ "key": key, "phase": "error", "message": message }));
            Err(message)
        }
    }
}

#[tauri::command]
fn remove_model(state: Shared, key: String) -> Result<Value, String> {
    if state.engine.running() {
        return Err("Disconnect before removing a model.".into());
    }
    let entry = install::find(&key).ok_or_else(|| format!("Unknown model \"{key}\"."))?;
    let dir = state.models_dir.join(entry["dir"].as_str().unwrap_or_default());
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    // Drop the selection if it pointed at what was just deleted.
    let mut cfg = state.config.lock().unwrap();
    if PathBuf::from(cfg.str("/modelPath")) == dir {
        cfg.update(json!({ "modelPath": "" }));
    }
    Ok(json!({ "ok": true }))
}

/// Ask GitHub whether a newer release exists. Notification only.
#[tauri::command]
async fn check_update(state: Shared<'_>, force: bool) -> Result<Value, String> {
    let cache = state.config.lock().unwrap().get("/updates").clone();
    let result = meta::check_for_update(env!("CARGO_PKG_VERSION"), &cache, force).await;
    // Remembered, so an offline launch still shows the badge. A refused check
    // knows nothing and must not erase what the last real one found.
    if result["state"] != "off" {
        let mut updates = cache;
        updates["lastCheck"] = result["lastCheck"].clone();
        updates["latest"] = result["latest"].clone();
        state.config.lock().unwrap().update(json!({ "updates": updates }));
    }
    Ok(result)
}

#[tauri::command]
fn copy(app: AppHandle, text: String) -> bool {
    app.clipboard().write_text(text).is_ok()
}

/// Only https links leave the app, and only to the browser.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> bool {
    url.starts_with("https://") && app.opener().open_url(url, None::<&str>).is_ok()
}

/// The fonts folder's files; asking also tells open overlays about new ones.
#[tauri::command]
fn list_fonts(state: Shared) -> Vec<String> {
    state.server.refresh_fonts()
}

#[tauri::command]
fn open_fonts_folder(app: AppHandle, state: Shared) -> Result<(), String> {
    std::fs::create_dir_all(&state.fonts_dir).map_err(|e| e.to_string())?;
    app.opener().open_path(state.fonts_dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_config(app: AppHandle, state: Shared) {
    let file = state.config.lock().unwrap().file.clone();
    let _ = app.opener().reveal_item_in_dir(file);
}

// -------------------------------------------------------------- lifecycle --

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // First, so a second launch hands over its arguments and exits before
        // anything else starts. A second copy would fight over the port.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            if argv.iter().any(|a| a == QUIT) {
                app.exit(0);
            } else {
                show_window(app);
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        on_hotkey(app, shortcut);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_state,
            update_config,
            set_token,
            sign_in,
            start,
            stop,
            mic_access,
            mic_audio,
            set_selected,
            set_color,
            set_alias,
            clear_captions,
            test_caption,
            set_paused,
            set_follow,
            set_me,
            report_problem,
            dismiss_whats_new,
            set_share_enabled,
            start_share,
            stop_share,
            rotate_share_token,
            model_catalog,
            install_model,
            remove_model,
            check_update,
            copy,
            open_external,
            reveal_config,
            list_fonts,
            open_fonts_folder,
        ])
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            // Asked to quit with nothing running: don't start a fresh copy.
            if args.iter().any(|a| a == QUIT) {
                std::process::exit(0);
            }

            // The folder the Electron build used, so an existing install keeps
            // its settings and models.
            let data_dir = app.path().config_dir()?.join("ChatterLayer");
            let mut config = Config::load(&data_dir);
            let version = env!("CARGO_PKG_VERSION");
            // Recorded as seen straight away, so it is once per update whether
            // or not anyone presses "Got it".
            let whats_new = meta::whats_new(version, config.str("/lastSeenVersion"), config.existed);
            // Coming from a version before the setup checklist existed means
            // they got set up without it; it's for first runs.
            if config.existed && config.str("/lastSeenVersion").is_empty() && config.get("/setupDone") != true {
                config.update(json!({ "setupDone": true }));
            }
            if config.str("/lastSeenVersion") != version {
                config.update(json!({ "lastSeenVersion": version }));
            }
            let models_dir = models::models_dir(&data_dir);
            let _ = std::fs::create_dir_all(&models_dir);

            let handle = app.handle().clone();
            let emit: discord::Emit = Arc::new(move |msg| relay(&handle, msg));
            let engine = Engine::new(emit, models_dir.clone(), app.path().resource_dir().ok());

            let handle = app.handle().clone();
            let fonts_dir = data_dir.join("fonts");
            let server = CaptionServer::new(fonts_dir.clone(), move |local, remote| {
                send(&handle, "chatterlayer:event", json!({ "type": "overlays", "local": local, "remote": remote }));
            });

            // Constructed, not started: remote sharing is always down at
            // launch, however the toggle was left.
            let handle = app.handle().clone();
            let tunnel = Tunnel::new(data_dir.join("bin"), Arc::new(move |e| on_tunnel(&handle, e)));

            let state = Arc::new(App {
                config: Mutex::new(config),
                server,
                engine,
                tunnel,
                models_dir,
                fonts_dir,
                discord: Mutex::new(json!({ "auth": "idle", "botTag": null, "botId": null, "message": "", "guilds": [] })),
                paused: AtomicBool::new(false),
                filter: RwLock::new(Filter::new(true, &[])),
                masked_total: AtomicUsize::new(0),
                colors: Mutex::new(HashMap::new()),
                tray_status: Mutex::new(("standby", 0)),
                test_line: AtomicUsize::new(0),
                downloading: Mutex::new(Default::default()),
                captions_live: AtomicBool::new(false),
                told_stopped: AtomicBool::new(false),
                whats_new: Mutex::new(Value::Null),
                share_key: Mutex::new(String::new()),
                quitting: AtomicBool::new(false),
            });
            state.rebuild_filter();
            *state.whats_new.lock().unwrap() = whats_new;
            app.manage(state.clone());

            build_tray(app.handle())?;
            apply_hotkeys(app.handle());
            // Re-pointed every launch, so a login item the Electron build left
            // behind starts this app instead.
            apply_login_item(app.handle());
            if !args.iter().any(|a| a == HIDDEN) {
                show_window(app.handle());
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let (server, overlay, token, source) = {
                    let cfg = state.config.lock().unwrap();
                    (cfg.get("/server").clone(), cfg.get("/overlay").clone(), cfg.token().to_string(), cfg.str("/source").to_string())
                };
                // Space back from any model download killed mid-flight last
                // run; the next attempt re-fetches whole files anyway.
                let (files, bytes) = install::sweep_partials(&state.models_dir);
                if files > 0 {
                    log(&handle, "info", format!(
                        "Cleared {files} unfinished model download file{} ({:.0} MB).",
                        if files == 1 { "" } else { "s" },
                        bytes as f64 / 1e6
                    ));
                }
                start_server(&handle, &state, &server).await;
                state.server.update_settings(json!({ "overlay": overlay }));
                // Sign in straight away so the pickers are populated before
                // anyone goes looking. This only logs the bot in — no model
                // is loaded and no channel joined until Connect. Not when only
                // the mic is captioned: then the app makes no connection to
                // Discord at all.
                if !token.is_empty() && source != "mic" {
                    let _ = state.engine.sign_in(&token).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // × parks the app in the tray rather than ending a live call,
            // unless that's switched off.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let state = app.state::<Arc<App>>();
                let park = state.config.lock().unwrap().get("/tray/closeToTray").as_bool() != Some(false);
                if park && !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    app.exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building ChatterLayer");

    app.run(|app, event| match event {
        // Started hidden in the tray, there's no window whose closing should
        // end the app; only Quit does.
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        // Leave the call and close the overlay server before the process goes.
        RunEvent::ExitRequested { api, code: Some(code), .. } => {
            let state = app.state::<Arc<App>>();
            if state.quitting.swap(true, Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<Arc<App>>();
                // The tunnel first: it's the only part visible from outside the
                // machine, and must not outlive the window on any exit path.
                state.tunnel.stop().await;
                let _ = tokio::time::timeout(std::time::Duration::from_secs(3), state.engine.shutdown()).await;
                state.server.stop().await;
                app.exit(code);
            });
        }
        _ => {}
    });
}
