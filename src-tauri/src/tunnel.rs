//! Optional Cloudflare Quick Tunnel in front of the caption server, so a group
//! of streamers can share one host's captions instead of each running their
//! own bot, model and CPU load.
//!
//! Three things are deliberate:
//!   - Nothing starts on its own. The tunnel is spawned only by an explicit
//!     Start, never on launch, never as a side effect of the toggle.
//!   - The binary is fetched on demand, not bundled. It is ~35 MB and most
//!     people stream alone and will never want it.
//!   - Quick Tunnels need no Cloudflare account and no domain; the cost is a
//!     random hostname that changes every run.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

/// How long to wait for cloudflared's banner before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(45);

/// A fixed release, never "latest", with each asset's SHA-256 written here.
/// Checksums fetched from the same release as the file would only catch a
/// broken download: whoever could replace a release could replace those too.
/// These were taken from the release notes and cross-checked against a real
/// download of the Windows build. Moving to a newer cloudflared means
/// updating the version and every hash together.
const VERSION: &str = "2026.9.3";

/// Which release asset this machine needs, its SHA-256, and whether it's a
/// .tgz. Windows on ARM gets the amd64 build: there's no windows/arm64 one,
/// and it runs fine under emulation.
fn asset() -> Option<(&'static str, &'static str, bool)> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86") => ("cloudflared-windows-386.exe", "9b95ddc2eba67b86ed3dc4cc2a15881960563031b52ce564376af41fb91ad402", false),
        ("windows", _) => ("cloudflared-windows-amd64.exe", "f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2", false),
        ("macos", "aarch64") => ("cloudflared-darwin-arm64.tgz", "5472c1a01c84bc31b3021056a73b4e5774ddddefc572124ea8fdf6c340639f32", true),
        ("macos", _) => ("cloudflared-darwin-amd64.tgz", "ab588b3b4db9cdb4476c30a3db2a72635b1d8327d44741fee6799a0f37b0ec07", true),
        ("linux", "aarch64") => ("cloudflared-linux-arm64", "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d", false),
        ("linux", "arm") => ("cloudflared-linux-arm", "967dc371a3fedbf09e881c13ee7ba317155ebc336cbd4afb756b46fc6785e5af", false),
        ("linux", "x86") => ("cloudflared-linux-386", "d6b2f917e2e78b3e3afba760af726e51751d10c2fcad4a2fb2a69feb4bd47421", false),
        ("linux", _) => ("cloudflared-linux-amd64", "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2", false),
        _ => return None,
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Pull one file out of a gzipped tar (the macOS assets). A tar is 512-byte
/// headers with an octal size field, and there's exactly one file we want.
fn extract_from_tgz(tgz: &[u8], wanted: &str) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(tgz), &mut buf).ok()?;
    let mut offset = 0;
    while offset + 512 <= buf.len() {
        let header = &buf[offset..offset + 512];
        // Zero blocks mark the end of the archive.
        if header[0] == 0 {
            break;
        }
        let field = |r: std::ops::Range<usize>| String::from_utf8_lossy(&header[r]).split('\0').next().unwrap_or("").trim().to_string();
        let name = field(0..100);
        let size = usize::from_str_radix(&field(124..136), 8).ok()?;
        let typeflag = header[156];
        offset += 512;
        // '0' and '\0' are both "regular file" in the wild.
        if (typeflag == b'0' || typeflag == 0) && Path::new(&name).file_name().is_some_and(|n| n == wanted) {
            return buf.get(offset..offset + size).map(<[u8]>::to_vec);
        }
        offset += size.div_ceil(512) * 512;
    }
    None
}

/// Phase updates for the sharing panel, and drops.
pub type Events = Arc<dyn Fn(TunnelEvent) + Send + Sync>;

pub enum TunnelEvent {
    Status(Value),
    /// cloudflared died on its own after the tunnel was up.
    Dropped(Option<i32>),
}

#[derive(Default)]
struct State {
    url: String,
    starting: bool,
    /// Set by `stop`, so the exit isn't reported as a drop.
    stopping: bool,
    kill: Option<oneshot::Sender<()>>,
}

pub struct Tunnel {
    bin_dir: PathBuf,
    events: Events,
    state: Arc<Mutex<State>>,
}

impl Tunnel {
    pub fn new(bin_dir: PathBuf, events: Events) -> Self {
        Self { bin_dir, events, state: Arc::default() }
    }

    pub fn url(&self) -> String {
        self.state.lock().unwrap().url.clone()
    }

    pub fn starting(&self) -> bool {
        self.state.lock().unwrap().starting
    }

    pub fn running(&self) -> bool {
        let st = self.state.lock().unwrap();
        st.kill.is_some() || st.starting
    }

    fn managed_path(&self) -> PathBuf {
        self.bin_dir.join(if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" })
    }

    /// "<version> <sha256 of the binary as installed>", written once the
    /// download has passed its check. On macOS the pinned hash is the
    /// archive's, so the unpacked binary's own hash is what gets recorded.
    fn record_path(&self) -> PathBuf {
        self.bin_dir.join("cloudflared.verified")
    }

    /// The managed copy, only if it is the pinned version and unchanged since
    /// it was checked. Anything else — an older copy the Electron build
    /// fetched from "latest", a damaged file — is fetched again.
    fn verified_managed(&self) -> Option<PathBuf> {
        let managed = self.managed_path();
        let record = std::fs::read_to_string(self.record_path()).ok()?;
        let (version, hash) = record.trim().split_once(' ')?;
        let actual = sha256_hex(&std::fs::read(&managed).ok()?);
        (version == VERSION && actual == hash).then_some(managed)
    }

    /// An existing cloudflared on PATH wins over downloading our own — plenty
    /// of people already have it from winget or Homebrew.
    async fn system_binary() -> Option<PathBuf> {
        let mut probe = Command::new("cloudflared");
        probe.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut probe);
        let ok = tokio::time::timeout(Duration::from_secs(5), probe.status()).await.ok()?.ok()?.success();
        ok.then(|| PathBuf::from("cloudflared"))
    }

    /// Download cloudflared into the app's folder, reporting progress.
    async fn install(&self) -> Result<PathBuf, String> {
        if let Some(managed) = self.verified_managed() {
            return Ok(managed);
        }
        if let Some(system) = Self::system_binary().await {
            return Ok(system);
        }
        let managed = self.managed_path();
        let (name, pinned, tgz) = asset().ok_or_else(|| {
            format!(
                "No cloudflared build for {}/{}. Install cloudflared yourself and it will be picked up from PATH.",
                std::env::consts::OS,
                std::env::consts::ARCH
            )
        })?;
        std::fs::create_dir_all(&self.bin_dir).map_err(|e| e.to_string())?;
        (self.events)(TunnelEvent::Status(json!({ "phase": "download", "received": 0, "total": 0 })));

        let client = reqwest::Client::builder().user_agent("ChatterLayer").build().map_err(|e| e.to_string())?;
        let url = format!("https://github.com/cloudflare/cloudflared/releases/download/{VERSION}/{name}");
        let res = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("Download failed: HTTP {}", res.status().as_u16()));
        }
        let total = res.content_length().unwrap_or(0);
        let mut body = Vec::with_capacity(total as usize);
        let mut stream = res.bytes_stream();
        let mut last = std::time::Instant::now();
        while let Some(chunk) = stream.next().await {
            body.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
            if last.elapsed() > Duration::from_millis(200) {
                last = std::time::Instant::now();
                (self.events)(TunnelEvent::Status(json!({ "phase": "download", "received": body.len(), "total": total })));
            }
        }
        (self.events)(TunnelEvent::Status(json!({ "phase": "install" })));
        // Checked before anything is written where it could be run.
        let got = sha256_hex(&body);
        if got != pinned {
            return Err(format!(
                "The cloudflared download failed its checksum (expected {}…, got {}…), so it was not run. \
                 Try again; if it keeps failing, don't use remote sharing until ChatterLayer is updated.",
                &pinned[..12],
                &got[..12]
            ));
        }
        let binary = if tgz {
            extract_from_tgz(&body, "cloudflared").ok_or("cloudflared was not found inside the downloaded archive.")?
        } else {
            body
        };
        let record = format!("{VERSION} {}", sha256_hex(&binary));
        // Staged then renamed, so a half-written binary is never run.
        let staged = managed.with_extension("part");
        std::fs::write(&staged, binary).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&staged, &managed).map_err(|e| e.to_string())?;
        std::fs::write(self.record_path(), record).map_err(|e| e.to_string())?;
        Ok(managed)
    }

    /// Spawn the tunnel and return its public https URL.
    pub async fn start(&self, port: u16) -> Result<String, String> {
        {
            let mut st = self.state.lock().unwrap();
            if st.kill.is_some() || st.starting {
                return Err("The tunnel is already running.".into());
            }
            *st = State { starting: true, ..State::default() };
        }
        let result = self.spawn(port).await;
        let mut st = self.state.lock().unwrap();
        st.starting = false;
        match result {
            Ok(url) if !st.stopping => {
                st.url = url.clone();
                Ok(url)
            }
            Ok(_) => Err("The tunnel was stopped while it started.".into()),
            Err(e) => {
                if let Some(kill) = st.kill.take() {
                    let _ = kill.send(());
                }
                Err(e)
            }
        }
    }

    async fn spawn(&self, port: u16) -> Result<String, String> {
        let bin = self.install().await?;
        (self.events)(TunnelEvent::Status(json!({ "phase": "starting" })));
        let mut cmd = Command::new(&bin);
        cmd.args([
            "tunnel",
            // Quick Tunnel: no account, no domain, random hostname.
            "--url",
            &format!("http://127.0.0.1:{port}"),
            // Never let cloudflared replace its own binary underneath us.
            "--no-autoupdate",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
        hide_window(&mut cmd);
        let mut child: Child = cmd.spawn().map_err(|e| format!("Could not run cloudflared: {e}"))?;

        // cloudflared writes its banner to stderr; read both to be safe.
        let (lines_tx, mut lines_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        for reader in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as _)].into_iter().flatten() {
            let tx = lines_tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(reader).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(line);
                }
            });
        }
        drop(lines_tx);

        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let (exit_tx, mut exit_rx) = oneshot::channel::<Option<i32>>();
        self.state.lock().unwrap().kill = Some(kill_tx);
        let state = self.state.clone();
        let events = self.events.clone();
        tokio::spawn(async move {
            let code = tokio::select! {
                status = child.wait() => status.ok().and_then(|s| s.code()),
                _ = kill_rx => {
                    let _ = child.kill().await;
                    None
                }
            };
            let (was_up, stopping) = {
                let mut st = state.lock().unwrap();
                let was_up = !st.url.is_empty();
                st.url.clear();
                st.kill = None;
                (was_up, st.stopping)
            };
            // An exit after it was live is a real drop, not a start failure.
            if was_up && !stopping {
                events(TunnelEvent::Dropped(code));
            }
            let _ = exit_tx.send(code);
        });

        let mut banner = String::new();
        let deadline = tokio::time::sleep(READY_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                line = lines_rx.recv() => match line {
                    Some(line) => {
                        if let Some(url) = find_url(&line) {
                            return Ok(url);
                        }
                        // A little context, so a failure has something to say.
                        banner.push_str(&line);
                        banner.push('\n');
                        if banner.len() > 2000 {
                            banner.drain(..banner.len() - 2000);
                        }
                    }
                    None => {
                        let code = (&mut exit_rx).await.ok().flatten();
                        let tail: Vec<&str> = banner.trim().lines().rev().take(3).collect();
                        let tail: String = tail.into_iter().rev().collect::<Vec<_>>().join(" ").chars().take(300).collect();
                        return Err(format!(
                            "cloudflared exited (code {}) before the tunnel came up.{}",
                            code.map_or("?".into(), |c| c.to_string()),
                            if tail.is_empty() { String::new() } else { format!(" {tail}") }
                        ));
                    }
                },
                _ = &mut deadline => {
                    return Err("cloudflared did not produce a tunnel URL in time. Check your network connection or firewall and try again.".into());
                }
            }
        }
    }

    /// Safe to call when already down.
    pub async fn stop(&self) {
        let kill = {
            let mut st = self.state.lock().unwrap();
            st.stopping = true;
            st.starting = false;
            st.url.clear();
            st.kill.take()
        };
        if let Some(kill) = kill {
            let _ = kill.send(());
            // Give the child a moment to go before anything else rebinds.
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

/// The hostname cloudflared prints in its banner.
fn find_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url: String = line[start..].chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '/' | '.' | '-')).collect();
    url.to_ascii_lowercase().ends_with(".trycloudflare.com").then_some(url)
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let _ = cmd;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_quick_tunnel_url() {
        let line = "2026-10-22 INF |  https://brave-otter-12.trycloudflare.com                                  |";
        assert_eq!(find_url(line).as_deref(), Some("https://brave-otter-12.trycloudflare.com"));
        assert_eq!(find_url("see https://www.cloudflare.com/terms"), None);
    }

    #[test]
    fn pinned_hash_is_well_formed() {
        let (_, hash, _) = asset().expect("an asset for this platform");
        assert!(hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    /// A real download of the pinned build, then a tampered copy:
    /// `CHATTERLAYER_TEST_DIR=path cargo test tunnel::tests -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn installs_only_the_pinned_build() {
        let dir = PathBuf::from(std::env::var("CHATTERLAYER_TEST_DIR").expect("CHATTERLAYER_TEST_DIR"));
        let tunnel = Tunnel::new(dir, Arc::new(|_| {}));
        assert!(tunnel.verified_managed().is_none());
        // Bypasses PATH, so the download itself is what's tested.
        let installed = {
            let fetched = tunnel.install().await.expect("install");
            assert_eq!(fetched, tunnel.managed_path(), "a cloudflared on PATH was used instead");
            fetched
        };
        assert_eq!(tunnel.verified_managed(), Some(installed.clone()));
        let mut bytes = std::fs::read(&installed).unwrap();
        bytes[1000] ^= 0xff;
        std::fs::write(&installed, bytes).unwrap();
        assert!(tunnel.verified_managed().is_none(), "a modified binary was still trusted");
    }
}
