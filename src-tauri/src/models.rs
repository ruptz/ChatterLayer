//! Installed speech models: finding them, naming them, and picking one.
//!
//! Discovery lives in layer-speech, shared with the other Layer apps. What's
//! ChatterLayer's own is here: its catalogue (models.json), where its models
//! are kept, and which one to load.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub use layer_speech::models::{MANIFEST_FILENAME, Model};
use layer_speech::models::Catalog;
use serde_json::Value;

/// The catalogue and the best-first ranking, as data. See models.json.
static CATALOG: LazyLock<Catalog> =
    LazyLock::new(|| Catalog::from_json(include_str!("../models.json")).expect("models.json"));

pub fn catalog() -> &'static [Value] {
    CATALOG.entries()
}

pub fn find_by_dir(dir: &str) -> Option<&'static Value> {
    CATALOG.find_by_dir(dir)
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

/// Is this directory a usable model, and if so whose?
pub fn identify(dir: &Path) -> Option<Model> {
    CATALOG.identify(dir)
}

/// Every installed model, best-first.
pub fn list(models_dir: &Path) -> Vec<Model> {
    CATALOG.list(models_dir)
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
    CATALOG.with_status(models_dir)
}
