//! Downloading speech models. They aren't shipped with the app — they run
//! 40 MB to 2.5 GB and each user needs exactly one — so the app fetches the
//! chosen one.
//!
//! Two download shapes:
//!   `url`    one zip containing a single top-level folder (Vosk)
//!   `files`  individual files fetched into the model directory (HuggingFace,
//!            pinned to a revision so upstream can't change under us)

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use md5::Md5;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::models::{self, MANIFEST_FILENAME};

const PART_SUFFIX: &str = ".part";

/// Progress for the picker: `{ phase, received?, total? }`.
pub type Progress<'a> = &'a (dyn Fn(Value) + Send + Sync);

pub fn find(key: &str) -> Option<&'static Value> {
    models::catalog().iter().find(|m| m["key"] == key || m["aliases"].as_array().is_some_and(|a| a.iter().any(|x| x == key)))
}

fn download_bytes(model: &Value) -> u64 {
    match model["files"].as_array() {
        Some(files) => files.iter().filter_map(|f| f["bytes"].as_u64()).sum(),
        // The archive's exact size; downloadMB is the rounded figure in the
        // picker, and using it ran the bar past 100% on every Vosk model.
        None => model["bytes"].as_u64().unwrap_or_else(|| (model["downloadMB"].as_f64().unwrap_or(0.0) * 1e6) as u64),
    }
}

/// Disk a fetch needs at its peak, with headroom. Files are written in place;
/// a Vosk zip is fetched and then unpacked beside itself.
fn footprint(model: &Value) -> u64 {
    if model["files"].is_array() { download_bytes(model) + 128_000_000 } else { download_bytes(model) * 3 }
}

/// Bytes free to this user on the volume holding `dir`; None when the
/// platform won't say, which never blocks an install.
#[cfg(windows)]
fn free_disk_bytes(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut probe = dir.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let wide: Vec<u16> = probe.as_os_str().encode_wide().chain([0]).collect();
    let mut free = 0u64;
    // SAFETY: a NUL-terminated path and a valid out pointer; the other two
    // outputs are optional.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}

#[cfg(unix)]
fn free_disk_bytes(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let mut probe = dir.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let path = std::ffi::CString::new(probe.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: a NUL-terminated path and a valid out pointer.
    (unsafe { libc::statvfs(path.as_ptr(), &mut stat) } == 0).then(|| stat.f_bavail as u64 * stat.f_frsize as u64)
}

fn hash_file<D: Digest>(path: &Path) -> std::io::Result<String> {
    let mut hasher = D::new();
    let mut file = fs::File::open(path)?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = std::io::Read::read(&mut file, &mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Delete `.part` files a killed download left behind. Downloads re-fetch
/// whole files rather than resume, so these are always dead weight.
pub fn sweep_partials(models_dir: &Path) -> (u64, u64) {
    let (mut files, mut bytes) = (0, 0);
    // A Vosk zip is fetched beside the model folders.
    let dirs = std::iter::once(models_dir.to_path_buf())
        .chain(models::catalog().iter().map(|m| models_dir.join(m["dir"].as_str().unwrap_or(""))));
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(PART_SUFFIX) {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if fs::remove_file(entry.path()).is_ok() {
                    files += 1;
                    bytes += size;
                }
            }
        }
    }
    (files, bytes)
}

/// Download a URL to disk, following redirects, reporting progress.
async fn download(client: &reqwest::Client, url: &str, dest: &Path, base: u64, total: u64, progress: Progress<'_>) -> Result<(), String> {
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Download failed: HTTP {}", res.status().as_u16()));
    }
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut received = base;
    let mut last_tick = Instant::now() - Duration::from_secs(1);
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        // Throttled: this drives a progress bar, not a log.
        if last_tick.elapsed() > Duration::from_millis(200) {
            last_tick = Instant::now();
            progress(json!({ "phase": "download", "received": received, "total": total }));
        }
    }
    file.flush().map_err(|e| e.to_string())
}

/// Fetch a zip and unpack it (Vosk). Checked before unpacking: exact size,
/// then sha256 if the catalogue has one, else upstream's md5. These are plain
/// filenames on alphacephei.com with nothing but the version to keep them
/// stable, so this matters more than for the pinned HuggingFace files.
async fn install_zip(client: &reqwest::Client, model: &Value, models_dir: &Path, target: &Path, progress: Progress<'_>) -> Result<(), String> {
    let dir = model["dir"].as_str().unwrap_or("");
    let zip_path = models_dir.join(format!("{dir}.zip{PART_SUFFIX}"));
    let result = async {
        download(client, model["url"].as_str().unwrap_or(""), &zip_path, 0, download_bytes(model), progress).await?;
        let size = fs::metadata(&zip_path).map_err(|e| e.to_string())?.len();
        if let Some(want) = model["bytes"].as_u64().filter(|&w| w != size) {
            return Err(format!("{dir}.zip downloaded as {size} bytes but should be {want}. The download was truncated or the upstream file changed."));
        }
        let check = match (model["sha256"].as_str(), model["md5"].as_str()) {
            (Some(want), _) => Some(("sha256", want, hash_file::<Sha256>(&zip_path))),
            (None, Some(want)) => Some(("md5", want, hash_file::<Md5>(&zip_path))),
            _ => None,
        };
        if let Some((algo, want, got)) = check {
            progress(json!({ "phase": "verify" }));
            let got = got.map_err(|e| e.to_string())?;
            if got != want {
                return Err(format!(
                    "{dir}.zip failed its {algo} checksum (expected {}…, got {}…). The download is corrupt — try again.",
                    &want[..12.min(want.len())],
                    &got[..12]
                ));
            }
        }
        progress(json!({ "phase": "extract" }));
        // The archives hold one top-level folder named for the model, so
        // unpacking into the models folder lands it in the right place.
        unpack(&zip_path, models_dir)?;
        if !target.exists() {
            return Err(format!("Archive unpacked but \"{dir}\" was not found inside it."));
        }
        Ok(())
    }
    .await;
    let _ = fs::remove_file(&zip_path);
    result
}

/// Unpack by hand rather than with `ZipArchive::extract`, which recreates
/// symlinks stored in the archive. A model is plain files and folders, so a
/// symlink, or a path reaching outside `dest`, means the archive was tampered
/// with. Every entry is checked before anything is written.
fn unpack(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut paths = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if entry.is_symlink() {
            return Err(format!("The archive contains a symlink ({name}), which no model needs. Refusing to unpack it."));
        }
        let Some(rel) = entry.enclosed_name() else {
            return Err(format!("The archive has an entry outside its folder ({name}). Refusing to unpack it."));
        };
        paths.push((dest.join(rel), entry.is_dir()));
    }
    for (i, (out, is_dir)) in paths.into_iter().enumerate() {
        if is_dir {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let mut file = fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Fetch a model served as individual files, straight into the target folder
/// under `.part` names: a 2.5 GB model would otherwise need the space twice,
/// and the final move could be a cross-volume copy.
async fn install_files(client: &reqwest::Client, model: &Value, target: &Path, progress: Progress<'_>) -> Result<(), String> {
    let total = download_bytes(model);
    let mut done = 0;
    for file in model["files"].as_array().into_iter().flatten() {
        let name = file["as"].as_str().unwrap_or("");
        let bytes = file["bytes"].as_u64().unwrap_or(0);
        let sha = file["sha256"].as_str();
        let dest = target.join(name);
        let part = target.join(format!("{name}{PART_SUFFIX}"));

        // A file already at its size is one an earlier attempt finished —
        // trusted, unless its checksum disagrees.
        if fs::metadata(&dest).is_ok_and(|m| m.len() == bytes) {
            if sha.is_none_or(|want| hash_file::<Sha256>(&dest).is_ok_and(|got| got == want)) {
                done += bytes;
                progress(json!({ "phase": "download", "received": done, "total": total }));
                continue;
            }
            let _ = fs::remove_file(&dest);
        }

        download(client, file["url"].as_str().unwrap_or(""), &part, done, total, progress).await?;
        let size = fs::metadata(&part).map_err(|e| e.to_string())?.len();
        if size != bytes {
            return Err(format!("{name} downloaded as {size} bytes but should be {bytes}. The download was truncated or the upstream file changed."));
        }
        if let Some(want) = sha {
            let got = hash_file::<Sha256>(&part).map_err(|e| e.to_string())?;
            if got != want {
                return Err(format!(
                    "{name} failed its checksum (expected {}…, got {}…). The download is corrupt — try again.",
                    &want[..12.min(want.len())],
                    &got[..12]
                ));
            }
        }
        fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        done += bytes;
        progress(json!({ "phase": "download", "received": done, "total": total }));
    }
    Ok(())
}

/// A manifest is written last, once every file is in place, so its presence
/// is what marks a model complete. A half-finished download never looks
/// installed.
fn write_manifest(target: &Path, model: &Value) -> Result<(), String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let manifest = json!({
        "chatterlayer": 1, "key": model["key"], "engine": model["engine"], "label": model["label"], "installedAt": now,
    });
    fs::write(target.join(MANIFEST_FILENAME), serde_json::to_vec_pretty(&manifest).unwrap()).map_err(|e| e.to_string())
}

/// Fetch and unpack a model. Returns its folder.
pub async fn install(key: &str, models_dir: &Path, progress: Progress<'_>) -> Result<PathBuf, String> {
    let model = find(key).ok_or_else(|| format!("Unknown model \"{key}\"."))?;
    let target = models_dir.join(model["dir"].as_str().unwrap_or(""));
    if models::identify(&target).is_some() {
        return Ok(target);
    }

    // Fail up front on an obviously-too-small disk rather than partway
    // through a multi-GB download.
    let need = footprint(model);
    if let Some(free) = free_disk_bytes(models_dir).filter(|&f| f < need) {
        let gb = |n: u64| format!("{:.1}", n as f64 / 1e9);
        return Err(format!(
            "Not enough free disk space for {}: it needs about {} GB free, but only {} GB is available where models are stored. \
             Free up some space and try again.",
            model["label"].as_str().unwrap_or("this model"),
            gb(need),
            gb(free)
        ));
    }
    fs::create_dir_all(models_dir).map_err(|e| e.to_string())?;

    // A stalled connection should fail, not hang the installer forever.
    let client = reqwest::Client::builder()
        .user_agent("ChatterLayer")
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let result = async {
        if model["files"].is_array() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            install_files(&client, model, &target, progress).await?;
        } else {
            install_zip(&client, model, models_dir, &target, progress).await?;
        }
        write_manifest(&target, model)
    }
    .await;
    if let Err(e) = result {
        // Never leave a half-extracted model occupying the disk.
        let _ = fs::remove_dir_all(&target);
        return Err(e);
    }
    Ok(target)
}

/// Total RAM and hardware threads, from the OS, never sent anywhere.
fn machine() -> (u64, usize) {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        // SAFETY: dwLength is set as the API requires.
        if unsafe { GlobalMemoryStatusEx(&mut status) } != 0 {
            return (status.ullTotalPhys, threads);
        }
    }
    #[cfg(target_os = "linux")]
    if let Some(kb) = fs::read_to_string("/proc/meminfo").ok().and_then(|m| {
        m.lines().find(|l| l.starts_with("MemTotal:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
    }) {
        return (kb * 1024, threads);
    }
    #[cfg(target_os = "macos")]
    if let Some(bytes) = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok()?.trim().parse::<u64>().ok())
    {
        return (bytes, threads);
    }
    (0, threads)
}

/// Which of the two recommended models suits this machine.
///
/// Parakeet is the better model by a distance, and "can run it" is a lower
/// bar than its 2.5 GB download suggests: ~2.6 GB of RAM to spare beside OBS, a
/// game and Discord, and a few cores. A PC sold as 16 GB reports a little under
/// 16 GiB, so the floor sits at 12 GiB. A machine that reports nothing gets the
/// lighter model, which runs anywhere.
pub fn suggestion() -> Value {
    let (mem, threads) = machine();
    let key_for = |tier: &str| models::catalog().iter().find(|m| m["recommended"] == tier).map(|m| m["key"].clone());
    let enough_ram = mem >= 12 * 1024u64.pow(3);
    let enough_cpu = threads >= 6;
    let ram_gb = (mem as f64 / 1024f64.powi(3)).round();
    if enough_ram && enough_cpu {
        json!({ "key": key_for("capable"), "tier": "capable", "limitedBy": null, "ramGB": ram_gb, "cpuThreads": threads })
    } else {
        json!({
            "key": key_for("light"), "tier": "light", "limitedBy": if enough_ram { "cpu" } else { "ram" },
            "ramGB": ram_gb, "cpuThreads": threads,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_with(dir: &Path, build: impl FnOnce(&mut zip::ZipWriter<fs::File>)) -> PathBuf {
        let path = dir.join("test.zip");
        let mut w = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        build(&mut w);
        w.finish().unwrap();
        path
    }

    #[test]
    fn unpack_refuses_symlinks_and_escapes() {
        let dir = std::env::temp_dir().join(format!("chatterlayer-unpack-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let opts = zip::write::SimpleFileOptions::default();
        let out = dir.join("out");

        let good = zip_with(&dir, |w| {
            w.add_directory("model/", opts).unwrap();
            w.start_file("model/am/final.mdl", opts).unwrap();
            w.write_all(b"weights").unwrap();
        });
        unpack(&good, &out).unwrap();
        assert_eq!(fs::read(out.join("model/am/final.mdl")).unwrap(), b"weights");

        let link = zip_with(&dir, |w| {
            w.start_file("model/ok", opts).unwrap();
            w.add_symlink("model/link", "../../outside", opts).unwrap();
        });
        let err = unpack(&link, &dir.join("out-link")).unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        // Checked up front, so nothing was written at all.
        assert!(!dir.join("out-link").exists());

        let escape = zip_with(&dir, |w| {
            w.start_file("../evil.txt", opts).unwrap();
        });
        assert!(unpack(&escape, &dir.join("out-escape")).unwrap_err().contains("outside"));
        assert!(!dir.join("evil.txt").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    /// Real downloads of one zip model and one file model, checksums and all:
    /// `CHATTERLAYER_TEST_DIR=path cargo test install::tests -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn installs_both_shapes() {
        let dir = PathBuf::from(std::env::var("CHATTERLAYER_TEST_DIR").expect("CHATTERLAYER_TEST_DIR"));
        let progress = |_: Value| {};
        for key in ["small", "whisper-tiny"] {
            let path = install(key, &dir, &progress).await.unwrap_or_else(|e| panic!("{key}: {e}"));
            assert!(models::identify(&path).is_some(), "{key} installed but not recognised");
        }
        assert_eq!(sweep_partials(&dir), (0, 0));
    }
}
