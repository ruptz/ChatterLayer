//! `chatterlayer-config.json` in the same per-user folder the Electron build
//! used (%APPDATA%\ChatterLayer), so an existing install keeps its settings.
//!
//! The bot token never goes in that file. It is a live credential that grants
//! control of the bot to anyone who reads it, so it lives in the OS keystore
//! (Credential Manager / Keychain / Secret Service). Only where there is no
//! keystore is it written to the file, with a warning beside it.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

pub const CONFIG_FILENAME: &str = "chatterlayer-config.json";

const KEYRING_SERVICE: &str = "ChatterLayer";
const KEYRING_USER: &str = "discord-bot-token";
/// Where the Electron build kept the token, sealed by its safeStorage.
const LEGACY_TOKEN_KEY: &str = "botTokenEncrypted";

fn defaults() -> Value {
    json!({
        // What gets captioned: "discord" (a voice call), "mic" (this PC's
        // microphone, which never signs in to Discord at all) or "both".
        "source": "discord",
        // The microphone to capture, by the browser's deviceId; empty = the
        // system default. Whether it is captioned is the `mic` entry in
        // `selected`, like anyone else's switch.
        "mic": { "deviceId": "", "sensitivity": 5, "hangMs": 700 },
        // The streamer's own Discord account. Captioning both the call and the
        // mic, their Discord audio is skipped while the mic is on.
        "me": { "userId": "" },
        "channelId": "",
        // Only restores the server picker to where it was left.
        "guildId": "",
        // Discord user IDs switched on for captioning.
        "selected": [],
        // userId -> "#rrggbb"; unset users fall back to the hashed palette.
        "colors": {},
        // userId -> the name shown on stream.
        "aliases": {},
        // Slur masking. On by default — captions go out live and unreviewed.
        "filter": { "enabled": true, "custom": [] },
        // A model folder; empty = the most accurate one installed.
        "modelPath": "",
        // Asking GitHub whether a newer build exists is a visible setting
        // rather than a hidden one. Nothing is ever downloaded.
        "updates": { "check": true, "lastCheck": 0, "latest": "" },
        // 127.0.0.1 keeps the overlay reachable only from this machine (OBS).
        "server": { "port": 8777, "host": "127.0.0.1" },
        // Remote overlay sharing. `enabled` only reveals the controls: the
        // tunnel needs an explicit Start and is always down at launch, and its
        // access key is minted per session and never saved.
        "share": { "enabled": false },
        "overlay": {
            "fontSize": 30,
            "captionLifetimeMs": 7000,
            "maxLines": 4,
            "showPartials": true,
            "showSpeakerName": true,
            // "card" (the accent-bar card), "box" (flat subtitles) or "text".
            "look": "card",
            "position": "bottom",
            "align": "left",
            // Background opacity and caption width, both in percent.
            "background": 72,
            "maxWidth": 92,
            // Outline thickness in px; 0 leaves just the soft halo.
            "outline": 0,
            // A font family by name; empty = the overlay's own stack.
            "font": "",
            "textColor": "#ffffff",
            // The user's own stylesheet, applied after the overlay's.
            "customCss": ""
        },
        // What the window's × does. On by default: a reflexive click shouldn't
        // end a live Discord connection and the caption feed mid-stream.
        "tray": { "closeToTray": true },
        "appearance": { "theme": "system" },
        // Follow mode: the one person whose channel moves the bot follows.
        "follow": { "userId": "" },
        // System-wide pause and clear shortcuts. Off: they'd steal keys.
        "hotkeys": { "enabled": false },
        "startup": { "atLogin": false },
        // The version whose "What's new" has been shown.
        "lastSeenVersion": "",
        // Set once the setup checklist is done or hidden; it never returns.
        "setupDone": false
    })
}

/// Stored values over defaults, recursively, so new keys appear on upgrade.
/// Keys only the stored side has (colour overrides, say) are kept.
fn merge_defaults(stored: Option<&Value>, defaults: &Value) -> Value {
    let Value::Object(d) = defaults else {
        return stored.cloned().unwrap_or_else(|| defaults.clone());
    };
    let s = stored.and_then(Value::as_object);
    let mut out = Map::new();
    for (key, dv) in d {
        let sv = s.and_then(|s| s.get(key));
        out.insert(key.clone(), match dv {
            Value::Object(_) => merge_defaults(sv, dv),
            _ => sv.cloned().unwrap_or_else(|| dv.clone()),
        });
    }
    if let Some(s) = s {
        for (key, sv) in s {
            out.entry(key.clone()).or_insert_with(|| sv.clone());
        }
    }
    Value::Object(out)
}

pub struct Config {
    pub dir: PathBuf,
    pub file: PathBuf,
    /// False on a first run. Tells an upgrade apart from a fresh install.
    pub existed: bool,
    pub data: Value,
    token: String,
    keystore: bool,
}

impl Config {
    pub fn load(dir: &Path) -> Self {
        let file = dir.join(CONFIG_FILENAME);
        let existed = file.exists();
        // A corrupt config should never brick the app — start fresh instead.
        let mut raw: Value = fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| json!({}));

        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok();
        let keystore = entry.as_ref().is_some_and(|e| match e.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => true,
            Err(_) => false,
        });
        let token = entry.as_ref().and_then(|e| e.get_password().ok()).unwrap_or_default();

        // What the Electron build left in the file: a safeStorage blob, or
        // plain text where it had no keystore. The blob is copied into the
        // keystore once and left where it is, so the Electron build keeps
        // working while both are around; plain text is removed.
        let mut adopt = None;
        let mut dirty = false;
        if let Some(obj) = raw.as_object_mut() {
            let legacy = obj.get(LEGACY_TOKEN_KEY).and_then(Value::as_str).map(str::to_string);
            let plain = obj.remove("botToken").and_then(|v| v.as_str().map(str::to_string));
            dirty |= plain.is_some() | obj.remove("_warning").is_some();
            // An earlier shape of remote sharing kept its access key here.
            if let Some(share) = obj.get_mut("share").and_then(Value::as_object_mut) {
                dirty |= share.remove("accessToken").is_some();
            }
            if token.is_empty() {
                adopt = legacy.and_then(|b| legacy_decrypt(dir, &b)).or(plain);
            }
        }

        let mut config = Self {
            dir: dir.to_path_buf(),
            file,
            existed,
            data: merge_defaults(Some(&raw), &defaults()),
            token,
            keystore,
        };
        if let Some(t) = adopt {
            config.store_token(&t);
        } else if dirty {
            config.save();
        }
        config
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// A token the user entered. It supersedes whatever the Electron build
    /// left behind, which must not come back if this one is cleared.
    pub fn set_token(&mut self, token: &str) {
        if let Value::Object(o) = &mut self.data {
            o.remove(LEGACY_TOKEN_KEY);
        }
        self.store_token(token);
    }

    fn store_token(&mut self, token: &str) {
        self.token = token.trim().to_string();
        if self.keystore {
            if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
                let stored = if self.token.is_empty() {
                    matches!(entry.delete_credential(), Ok(()) | Err(keyring::Error::NoEntry))
                } else {
                    entry.set_password(&self.token).is_ok()
                };
                if !stored {
                    self.keystore = false;
                }
            }
        }
        self.save();
    }

    /// Shallow patch, then defaults again, as the Electron build did.
    pub fn update(&mut self, patch: Value) {
        if let (Value::Object(data), Value::Object(patch)) = (&mut self.data, patch) {
            for (k, v) in patch {
                data.insert(k, v);
            }
        }
        self.data = merge_defaults(Some(&self.data), &defaults());
        self.save();
    }

    pub fn get(&self, pointer: &str) -> &Value {
        self.data.pointer(pointer).unwrap_or(&Value::Null)
    }

    pub fn str(&self, pointer: &str) -> &str {
        self.get(pointer).as_str().unwrap_or("")
    }

    /// Config for the window — never includes the raw token.
    pub fn to_client(&self) -> Value {
        let mut out = self.data.clone();
        if let Value::Object(o) = &mut out {
            o.remove(LEGACY_TOKEN_KEY);
            o.insert("hasToken".into(), json!(!self.token.is_empty()));
            o.insert("tokenEncrypted".into(), json!(self.keystore));
            o.insert("configPath".into(), json!(self.file.display().to_string()));
        }
        out
    }

    fn save(&self) {
        let mut out = self.data.clone();
        if !self.keystore && !self.token.is_empty() {
            if let Value::Object(o) = &mut out {
                o.insert("botToken".into(), json!(self.token));
                o.insert(
                    "_warning".into(),
                    json!("This machine has no OS keystore, so the bot token is stored in plaintext. Keep this file private."),
                );
            }
        }
        let write = || -> std::io::Result<()> {
            fs::create_dir_all(&self.dir)?;
            let tmp = self.file.with_extension("json.tmp");
            fs::write(&tmp, serde_json::to_vec_pretty(&out)?)?;
            fs::rename(&tmp, &self.file)
        };
        if let Err(e) = write() {
            eprintln!("[chatterlayer] failed to save config: {e}");
        }
    }
}

/// Electron's safeStorage on Windows: an AES-256-GCM key, itself sealed with
/// DPAPI in Chromium's `Local State`, and "v10" + nonce + ciphertext per value.
#[cfg(windows)]
fn legacy_decrypt(dir: &Path, b64: &str) -> Option<String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;

    let state: Value = serde_json::from_slice(&fs::read(dir.join("Local State")).ok()?).ok()?;
    let sealed = STANDARD.decode(state.pointer("/os_crypt/encrypted_key")?.as_str()?).ok()?;
    let key = dpapi_unprotect(sealed.strip_prefix(b"DPAPI")?)?;
    let blob = STANDARD.decode(b64).ok()?;
    let body = blob.strip_prefix(b"v10")?;
    if body.len() < 12 {
        return None;
    }
    let (nonce, ciphertext) = body.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let plain = cipher.decrypt(Nonce::from_slice(nonce), ciphertext).ok()?;
    String::from_utf8(plain).ok()
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData};

    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: both blobs are valid for the call; the output buffer is
    // allocated by DPAPI and released with LocalFree once copied.
    unsafe {
        if CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut output) == 0 {
            return None;
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Some(out)
    }
}

/// Other platforms' safeStorage keys live in the Electron app's own keychain
/// entry; there the token is simply pasted again.
#[cfg(not(windows))]
fn legacy_decrypt(_dir: &Path, _b64: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_stored_and_fills_new_keys() {
        let stored = json!({ "overlay": { "fontSize": 40 }, "colors": { "1": "#fff" }, "extra": 1 });
        let m = merge_defaults(Some(&stored), &defaults());
        assert_eq!(m["overlay"]["fontSize"], 40);
        assert_eq!(m["overlay"]["maxLines"], 4);
        assert_eq!(m["colors"]["1"], "#fff");
        assert_eq!(m["extra"], 1);
    }
}
