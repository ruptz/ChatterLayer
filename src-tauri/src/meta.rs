//! What the app says about itself: whether a newer release exists, the
//! prefilled bug report, and the "What's new" card.

use std::cmp::Ordering;
use std::time::Duration;

use serde_json::{Value, json};

const OWNER_REPO: &str = "ruptz/ChatterLayer";
pub const RELEASES_PAGE: &str = "https://github.com/ruptz/ChatterLayer/releases/latest";

/// A courtesy check must never hold up a launch.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(6);

// ------------------------------------------------------------- versions ---

/// `v1.2.3` and `1.2.3-rc.1` both parse; anything else doesn't.
fn parse_version(raw: &str) -> Option<([u64; 3], String)> {
    let raw = raw.trim().trim_start_matches('v');
    let (core, pre) = raw.split_once('-').unwrap_or((raw, ""));
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = [parts.next()??, parts.next()??, parts.next()??];
    if parts.next().is_some() || (raw.contains('-') && pre.is_empty()) {
        return None;
    }
    Some((v, pre.to_string()))
}

/// A version we can't parse compares equal, so a tag in some unexpected shape
/// can never announce itself as an update.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let (Some((va, pa)), Some((vb, pb))) = (parse_version(a), parse_version(b)) else { return Ordering::Equal };
    va.cmp(&vb).then_with(|| match (pa.is_empty(), pb.is_empty()) {
        // 1.0.0 is the release of 1.0.0-rc.1, so the plain one is newer.
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => pa.cmp(&pb),
    })
}

fn verdict(current: &str, latest: &str) -> &'static str {
    if !latest.is_empty() && compare_versions(current, latest) == Ordering::Less { "available" } else { "current" }
}

// -------------------------------------------------------------- updates ---

/// The newest published tag, or "" when nothing is published yet. GitHub
/// leaves drafts and prereleases out of this endpoint, which is what we want.
async fn latest_tag(current: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        // The GitHub API rejects requests that don't identify themselves.
        .user_agent(format!("ChatterLayer/{current}"))
        .timeout(UPDATE_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!("https://api.github.com/repos/{OWNER_REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "Timed out".to_string() } else { e.to_string() })?;
    // 404 is "nothing published yet": nothing newer, and not a failure.
    if res.status().as_u16() == 404 {
        return Ok(String::new());
    }
    if !res.status().is_success() {
        return Err(format!("GitHub replied {}", res.status().as_u16()));
    }
    let body: Value = res.json().await.map_err(|_| "Couldn't read GitHub's reply".to_string())?;
    Ok(body["tag_name"].as_str().unwrap_or("").to_string())
}

/// Tells the user when a newer release exists. Nothing is downloaded. This
/// is the only request ChatterLayer makes on its own initiative, so it runs
/// once per launch, gives up quickly, and can be switched off. `force` is the
/// user pressing something: the consent is in the gesture.
pub async fn check_for_update(current: &str, cache: &Value, force: bool) -> Value {
    let last_check = cache["lastCheck"].as_u64().unwrap_or(0);
    let known = cache["latest"].as_str().unwrap_or("");
    if cache["check"] != true && !force {
        return json!({ "state": "off", "current": current, "url": RELEASES_PAGE, "latest": "", "lastCheck": last_check });
    }
    match latest_tag(current).await {
        Ok(latest) => json!({
            "state": verdict(current, &latest), "current": current, "url": RELEASES_PAGE,
            "latest": latest, "lastCheck": now_ms(),
        }),
        // Offline, rate-limited, or GitHub having a day. Someone who saw an
        // update yesterday and launched offline today is still told.
        Err(message) => json!({
            "state": if verdict(current, known) == "available" { "available" } else { "error" },
            "current": current, "url": RELEASES_PAGE, "latest": known, "lastCheck": last_check, "message": message,
        }),
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ------------------------------------------------------------ bug report ---

/// How much of the Log panel goes into the link. GitHub stops accepting URLs
/// somewhere past 8 KB, and the end of the log is where the failure is.
const LOG_MAX_CHARS: usize = 3000;

/// The bug form's "Operating system" option for this machine, or "".
fn os_option() -> &'static str {
    if cfg!(windows) {
        // Windows 11 still reports itself as 10.0; the build number is the tell.
        if windows_build() >= 22000 { "Windows 11" } else { "Windows 10" }
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "macOS (Apple Silicon)" } else { "macOS (Intel)" }
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        ""
    }
}

#[cfg(windows)]
fn windows_build() -> u32 {
    use windows_sys::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (key, value) = (wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"), wide("CurrentBuildNumber"));
    let mut buf = [0u16; 32];
    let mut size = std::mem::size_of_val(&buf) as u32;
    // SAFETY: NUL-terminated names, and a buffer whose byte size is passed.
    let status = unsafe {
        RegGetValueW(HKEY_LOCAL_MACHINE, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size)
    };
    if status != 0 {
        return 0;
    }
    String::from_utf16_lossy(&buf).trim_end_matches('\0').parse().unwrap_or(0)
}

#[cfg(not(windows))]
fn windows_build() -> u32 {
    0
}

/// The form's "How you installed it" option, or "" when none fits yet.
fn build_option() -> &'static str {
    if cfg!(debug_assertions) { "From source (npm start)" } else { "" }
}

/// Anything token-shaped or matching a known secret, gone; the tail kept.
/// The token is never written to the log in the first place; this is for one
/// pasted into a filter word or a caption name by mistake.
pub fn scrub_log(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        out = out.replace(secret, "[removed]");
    }
    let out = remove_token_shapes(&out);
    let out = out.trim();
    if out.chars().count() <= LOG_MAX_CHARS {
        return out.to_string();
    }
    let tail: String = out.chars().skip(out.chars().count() - LOG_MAX_CHARS).collect();
    // Cut on a line boundary so the first line isn't half a timestamp.
    match tail.find('\n') {
        Some(nl) => tail[nl + 1..].to_string(),
        None => tail,
    }
}

/// Discord's three-part token shape, `[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}`.
fn remove_token_shapes(text: &str) -> String {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        let start = rest.find(word).unwrap_or(rest.len());
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let run_end = rest.find(|c: char| !(word(c) || c == '.')).unwrap_or(rest.len());
        let run = &rest[..run_end];
        let parts: Vec<&str> = run.split('.').collect();
        let is_token = parts.windows(3).any(|w| w[0].len() >= 20 && w[1].len() >= 5 && w[2].len() >= 20);
        out.push_str(if is_token { "[removed]" } else { run });
        rest = &rest[run_end..];
    }
    out
}

/// GitHub's new-issue page with the bug form filled in. Field ids and option
/// strings are a contract with .github/ISSUE_TEMPLATE/bug_report.yml.
/// Nothing is sent: it opens in the browser, where they read it and decide.
pub fn report_url(version: &str, model: &str, log: &str) -> String {
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    params.append_pair("template", "bug_report.yml");
    for (id, value) in [("version", version), ("os", os_option()), ("build", build_option()), ("model", model), ("log", log)] {
        if !value.is_empty() {
            params.append_pair(id, value);
        }
    }
    format!("https://github.com/{OWNER_REPO}/issues/new?{}", params.finish())
}

// ------------------------------------------------------------ what's new ---

/// Newest first. Shipped inside the app rather than fetched, so someone who
/// switched the update check off still learns what changed. The release
/// workflow reads the same file for the GitHub release notes, so this is the
/// one place they are written.
static NOTES: std::sync::LazyLock<Vec<Value>> =
    std::sync::LazyLock::new(|| serde_json::from_str(include_str!("../whats-new.json")).expect("whats-new.json"));

/// What to show at this launch, or null. Once means once: decided at
/// launch, recorded straight away. `upgraded` (a config existed before this
/// launch) tells a fresh install, with nothing to announce, from an upgrade
/// from a version too old to have recorded `last_seen`.
pub fn whats_new(current: &str, last_seen: &str, upgraded: bool) -> Value {
    if last_seen.is_empty() && !upgraded {
        return Value::Null;
    }
    let shown: Vec<Value> = NOTES
        .iter()
        .filter(|n| {
            let v = n["version"].as_str().unwrap_or("");
            compare_versions(v, current) != Ordering::Greater
                // With no record of what came before, only this version's
                // notes are safe to claim as new.
                && if last_seen.is_empty() { v == current } else { compare_versions(v, last_seen) == Ordering::Greater }
        })
        .cloned()
        .collect();
    if shown.is_empty() { Value::Null } else { json!(shown) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(compare_versions("0.4.0", "v0.5.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "1.0.0-rc.1"), Ordering::Greater);
        assert_eq!(compare_versions("1.0", "9.9.9"), Ordering::Equal);
        assert_eq!(verdict("0.5.0", "v0.4.0"), "current");
    }

    #[test]
    fn scrubs_tokens_and_secrets() {
        let token = format!("{}.{}.{}", "a".repeat(24), "b".repeat(6), "c".repeat(27));
        let out = scrub_log(&format!("token {token} and key XYZ"), &["XYZ"]);
        assert_eq!(out, "token [removed] and key [removed]");
        assert_eq!(scrub_log("plain text. fine", &[]), "plain text. fine");
    }

    #[test]
    fn whats_new_once() {
        assert!(whats_new("0.4.0", "", false).is_null());
        assert_eq!(whats_new("0.4.0", "0.3.0", true)[0]["version"], "0.4.0");
        assert!(whats_new("0.4.0", "0.4.0", true).is_null());
        // From 0.4.0 to 0.5.0: this release only, not the one they already saw.
        let shown = whats_new("0.5.0", "0.4.0", true);
        assert_eq!(shown.as_array().map(Vec::len), Some(1));
        assert_eq!(shown[0]["version"], "0.5.0");
    }
}
