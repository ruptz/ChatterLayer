//! Installed speech models: finding them, naming them, and picking one.
//!
//! Model discovery is manifest-driven. Every model the app installs gets a
//! `chatterlayer-model.json` naming its engine, so a directory on disk is
//! self-describing. Vosk models installed before manifests existed are still
//! recognised by their Kaldi layout.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::Serialize;
use serde_json::{Value, json};

pub const MANIFEST_FILENAME: &str = "chatterlayer-model.json";

/// The catalogue and the best-first ranking, as data. See models.json.
static DATA: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../models.json")).expect("models.json"));

pub fn catalog() -> &'static [Value] {
    DATA["catalog"].as_array().expect("catalog")
}

fn rank_of(dir: &str) -> usize {
    let rank = DATA["rank"].as_array().expect("rank");
    rank.iter().position(|r| r == dir).unwrap_or(rank.len())
}

pub fn find_by_dir(dir: &str) -> Option<&'static Value> {
    catalog().iter().find(|m| m["dir"] == dir)
}

fn format_size(mb: f64) -> String {
    if mb >= 1000.0 { format!("{:.1} GB", mb / 1000.0) } else { format!("{mb} MB") }
}

/// Picker label: name, approximate size, one short note.
fn label_for(entry: &Value) -> String {
    format!(
        "{} — {}, {}",
        entry["label"].as_str().unwrap_or(""),
        format_size(entry["downloadMB"].as_f64().unwrap_or(0.0)),
        entry["note"].as_str().unwrap_or("")
    )
}

/// Where downloaded models live. A source checkout keeps them beside the code,
/// as the Electron build did; an installed one in the user's data folder.
pub fn models_dir(data_dir: &Path) -> PathBuf {
    if let Some(dir) = std::env::var_os("CHATTERLAYER_MODELS_DIR") {
        return dir.into();
    }
    if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("models")
    } else {
        data_dir.join("models")
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub name: String,
    pub path: PathBuf,
    pub engine: String,
    pub key: Option<String>,
    pub label: String,
    pub max_speakers: Option<u64>,
}

fn read_manifest(dir: &Path) -> Option<Value> {
    let m: Value = serde_json::from_slice(&fs::read(dir.join(MANIFEST_FILENAME)).ok()?).ok()?;
    m["engine"].is_string().then_some(m)
}

fn looks_like_vosk(dir: &Path) -> bool {
    dir.join("conf").exists() || dir.join("am").exists()
}

/// Is this directory a usable model, and if so whose?
pub fn identify(dir: &Path) -> Option<Model> {
    let name = dir.file_name()?.to_string_lossy().to_string();
    let entry = find_by_dir(&name);
    let (engine, key, label) = if let Some(m) = read_manifest(dir) {
        (
            m["engine"].as_str()?.to_string(),
            m["key"].as_str().map(str::to_string).or_else(|| entry.and_then(|e| e["key"].as_str().map(str::to_string))),
            entry.map(label_for).or_else(|| m["label"].as_str().map(str::to_string)).unwrap_or_else(|| name.clone()),
        )
    } else if looks_like_vosk(dir) {
        (
            "vosk".to_string(),
            entry.and_then(|e| e["key"].as_str().map(str::to_string)),
            entry.map(label_for).unwrap_or_else(|| name.clone()),
        )
    } else {
        return None;
    };
    Some(Model {
        path: dir.to_path_buf(),
        engine,
        key,
        label,
        max_speakers: entry.and_then(|e| e["maxSpeakers"].as_u64()),
        name,
    })
}

/// Every installed model, best-first.
pub fn list(models_dir: &Path) -> Vec<Model> {
    let Ok(entries) = fs::read_dir(models_dir) else { return Vec::new() };
    let mut models: Vec<Model> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| identify(&e.path()))
        .collect();
    models.sort_by(|a, b| rank_of(&a.name).cmp(&rank_of(&b.name)).then(a.name.cmp(&b.name)));
    models
}

/// Which model to load: the one chosen in the app, else the most accurate one
/// installed.
pub fn resolve(models_dir: &Path, chosen: &str) -> Result<Model, String> {
    let env = std::env::var("CHATTERLAYER_MODEL").unwrap_or_default();
    for candidate in [env.as_str(), chosen] {
        if candidate.is_empty() || !Path::new(candidate).exists() {
            continue;
        }
        return identify(Path::new(candidate)).ok_or_else(|| {
            format!(
                "\"{candidate}\" does not look like a speech model ChatterLayer can open. \
                 Pick one from the Speech model panel."
            )
        });
    }
    list(models_dir).into_iter().next().ok_or_else(|| {
        "No speech model installed yet. Download one from the Speech model panel.".to_string()
    })
}

/// Catalogue annotated with whether each model is already on disk.
pub fn catalog_with_status(models_dir: &Path) -> Vec<Value> {
    catalog()
        .iter()
        .map(|m| {
            let target = models_dir.join(m["dir"].as_str().unwrap_or(""));
            let installed = target.exists()
                && (read_manifest(&target).is_some() || (m["engine"] == "vosk" && looks_like_vosk(&target)));
            let mut out = m.clone();
            out["installed"] = json!(installed);
            out["path"] = json!(target.display().to_string());
            out
        })
        .collect()
}
