use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, io::{Read, Write}, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter, Manager};

const RELEASES_URL: &str = "https://api.github.com/repos/lakesidegamedev/AHDGame/releases?per_page=50";
const MIN_VERSION: (u64, u64, u64) = (1, 6, 0);
/// Game versions below this are the Classic generation: worlds made before the
/// 1.20 rules, which stay on a pre-1.20 runtime and are never upgraded.
const CLASSIC_BELOW: (u64, u64, u64) = (1, 20, 0);
/// Stamped on a new world when the running game cannot say its own version.
pub const FALLBACK_STAMP: &str = "1.20.0";
/// Set by `cancel_download`, read by the download loop.
static CANCEL_DOWNLOAD: AtomicBool = AtomicBool::new(false);
/// How long the published-release list is reused before asking GitHub again.
const RELEASES_CACHE_SECS: u64 = 3600;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameVersion {
  pub version: String,
  pub installed: bool,
  pub selected: bool,
  /// Download size for this computer, when the release lists it.
  pub size_bytes: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Release { tag_name: String, assets: Vec<Asset> }

#[derive(Clone, Deserialize, Serialize)]
struct Asset {
  name: String,
  browser_download_url: String,
  #[serde(default)]
  size: Option<u64>,
}

#[derive(Deserialize, Serialize)]
struct ReleasesCache { fetched_at: u64, releases: Vec<Release> }

fn now_secs() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

fn cache_is_fresh(fetched_at: u64, now: u64) -> bool { now >= fetched_at && now - fetched_at < RELEASES_CACHE_SECS }

/// The newest game version any world (other than Classic ones) has been opened
/// with. Versions older than this are not offered: an older runtime could not
/// read what a newer one wrote. Worlds flagged `"classic": true` are skipped so
/// the Classic runtime stays installable beside a newer game.
fn newest_opened_version(worlds_dir: &Path) -> Option<(u64, u64, u64)> {
  fs::read_dir(worlds_dir).ok()?.flatten().filter_map(|entry| {
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(entry.path().join("world.json")).ok()?).ok()?;
    if value.get("classic").and_then(|v| v.as_bool()).unwrap_or(false) { return None; }
    parse_version(value.get("gameVersion")?.as_str()?)
  }).max()
}

fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
  let value = value.trim().trim_start_matches("game-v").trim_start_matches('v');
  let mut pieces = value.split('.');
  let parsed = (pieces.next()?.parse().ok()?, pieces.next()?.parse().ok()?, pieces.next()?.parse().ok()?);
  if pieces.next().is_some() { return None; }
  Some(parsed)
}

pub fn is_classic_version(value: &str) -> bool { parse_version(value).is_some_and(|version| version < CLASSIC_BELOW) }

/// A world is Classic when it says so, when it carries a pre-1.20 stamp, or when
/// it has no stamp at all (made before worlds remembered their game version).
pub fn world_is_classic(game_version: Option<&str>, classic_flag: bool) -> bool {
  classic_flag || game_version.is_none_or(is_classic_version)
}

/// Which game runtime a world starts on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Runtime {
  /// The runtime the app would start now (bundled, or the picked version).
  Current,
  /// An installed Classic runtime, by version.
  Classic(String),
}

/// Prefix of the error `game_start` returns when a Classic world needs the
/// Classic download first. The client matches on it to offer the download.
pub const CLASSIC_REQUIRED: &str = "classic-required:";

/// The runtime for a world. A Classic world is checked here, before anything
/// starts, so a newer runtime can never open it by accident.
pub fn choose_runtime(world_classic: bool, current: Option<&str>, installed_classic: &[String], pinned: Option<&str>) -> Result<Runtime, String> {
  if !world_classic { return Ok(Runtime::Current); }
  // The world was made by the runtime that would start now: keep using it. An
  // older downloaded runtime must not take over a world the app's own game made.
  if let (Some(pinned), Some(current)) = (pinned, current) {
    if is_classic_version(current) && parse_version(pinned).is_some() && parse_version(pinned) == parse_version(current) {
      return Ok(Runtime::Current);
    }
  }
  if let Some(version) = pinned.filter(|v| installed_classic.iter().any(|i| i == v)) {
    return Ok(Runtime::Classic(version.to_string()));
  }
  // Never open a world on a runtime older than the one that made it: an older
  // game cannot read what a newer one wrote, or rejects its setup outright.
  let floor = pinned.and_then(parse_version);
  let fits = |v: &str| floor.is_none_or(|floor| parse_version(v).is_some_and(|v| v >= floor));
  if let Some(version) = newest_classic(installed_classic.iter().map(String::as_str).filter(|v| fits(v))) {
    return Ok(Runtime::Classic(version));
  }
  if current.is_some_and(|c| is_classic_version(c) && fits(c)) { return Ok(Runtime::Current); }
  Err(format!("{CLASSIC_REQUIRED} This world was made with an earlier game version. Download the Classic game to open it."))
}

/// The newest valid version below 1.20.
fn newest_classic<'a>(versions: impl Iterator<Item = &'a str>) -> Option<String> {
  versions.filter(|v| valid_version(v) && is_classic_version(v)).max_by_key(|v| parse_version(v)).map(str::to_string)
}

fn valid_version(value: &str) -> bool { parse_version(value).is_some_and(|version| version >= MIN_VERSION) }

fn target_name_for(os: &str, arch: &str) -> Option<&'static str> {
  match (os, arch) {
    ("windows", "x86_64") => Some("windows-x86_64"),
    ("macos", "aarch64") => Some("macos-aarch64"),
    ("macos", "x86_64") => Some("macos-x86_64"),
    ("linux", "aarch64") => Some("linux-aarch64"),
    ("linux", "x86_64") => Some("linux-x86_64"),
    _ => None,
  }
}

fn target_name() -> Result<&'static str, String> {
  target_name_for(std::env::consts::OS, std::env::consts::ARCH)
    .ok_or_else(|| format!("Game downloads do not support {}/{}.", std::env::consts::OS, std::env::consts::ARCH))
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("game-versions"))
}

fn selected_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(root(app)?.join("selected")) }

pub fn selected(app: &AppHandle) -> Option<String> {
  fs::read_to_string(selected_path(app).ok()?).ok().map(|v| v.trim().to_string()).filter(|v| valid_version(v))
}

pub fn game_dir(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(version) = selected(app) {
    let installed = root(app)?.join(&version).join("game");
    if installed.join("launch.mjs").is_file() { return Ok(installed); }
  }
  Ok(app.path().resource_dir().map_err(|e| e.to_string())?.join("game"))
}

/// Reads `singleplayer-capabilities.json` from a staged game directory.
/// Returns None when the file is absent, unreadable, or not a JSON object, so
/// older runtimes that ship no manifest fall back to the client's own table.
pub fn read_capabilities(dir: &Path) -> Option<serde_json::Value> {
  let text = fs::read_to_string(dir.join("singleplayer-capabilities.json")).ok()?;
  let value: serde_json::Value = serde_json::from_str(&text).ok()?;
  if value.is_object() { Some(value) } else { None }
}

/// What `AHD_BUILD.json` says about the game staged in `dir`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledGameInfo {
  pub game_version: Option<String>,
  pub game_commit: Option<String>,
  pub client_version: Option<String>,
}

pub fn read_build_info(dir: &Path) -> BundledGameInfo {
  let Some(value) = fs::read_to_string(dir.join("AHD_BUILD.json")).ok()
    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok()) else { return BundledGameInfo::default(); };
  let text = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_string);
  BundledGameInfo {
    game_version: text("gameVersion").filter(|v| parse_version(v).is_some()),
    game_commit: text("gameCommit"),
    client_version: text("clientVersion"),
  }
}

fn fetch_releases_live() -> Result<Vec<Release>, String> {
  ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build()
    .get(RELEASES_URL).set("User-Agent", "AHDClient/2").call()
    .map_err(|_| "Cannot check game versions. Connect to the internet and try again.".to_string())?
    .into_json().map_err(|_| "GitHub returned an invalid game release list.".to_string())
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(root(app)?.join("releases-cache.json")) }

/// Published releases, reused from disk for an hour. A failed refresh falls
/// back to an older cache so the picker still works offline.
fn fetch_releases(app: &AppHandle, force: bool) -> Result<Vec<Release>, String> {
  let cached = cache_path(app).ok()
    .and_then(|path| fs::read_to_string(path).ok())
    .and_then(|text| serde_json::from_str::<ReleasesCache>(&text).ok());
  if !force {
    if let Some(cache) = cached.as_ref().filter(|c| cache_is_fresh(c.fetched_at, now_secs())) {
      return Ok(cache.releases.clone());
    }
  }
  match fetch_releases_live() {
    Ok(releases) => {
      if let Ok(path) = cache_path(app) {
        let _ = fs::create_dir_all(root(app)?);
        if let Ok(bytes) = serde_json::to_vec(&ReleasesCache { fetched_at: now_secs(), releases: releases.clone() }) {
          let _ = fs::write(path, bytes);
        }
      }
      Ok(releases)
    }
    Err(error) => cached.map(|c| c.releases).ok_or(error),
  }
}

fn installed_versions(versions_root: &Path) -> Vec<String> {
  fs::read_dir(versions_root).into_iter().flatten().flatten()
    .map(|entry| entry.file_name().to_string_lossy().to_string())
    .filter(|version| valid_version(version) && versions_root.join(version).join("game/launch.mjs").is_file())
    .collect()
}

/// Installed Classic runtimes, oldest first is not promised; use `choose_runtime`.
pub fn installed_classic(app: &AppHandle) -> Vec<String> {
  root(app).map(|dir| installed_versions(&dir)).unwrap_or_default().into_iter().filter(|v| is_classic_version(v)).collect()
}

/// Where an installed runtime lives.
pub fn runtime_dir(app: &AppHandle, version: &str) -> Result<PathBuf, String> { Ok(root(app)?.join(version).join("game")) }

/// The version the app would start now, when it can tell.
pub fn current_version(app: &AppHandle) -> Option<String> {
  game_dir(app).ok().and_then(|dir| read_build_info(&dir).game_version).or_else(|| selected(app))
}

/// The Classic runtime: the newest published release below 1.20.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicInfo {
  /// Version to use or download. None when none is installed or published.
  pub version: Option<String>,
  pub installed: bool,
  pub size_bytes: Option<u64>,
}

pub fn classic_info(app: &AppHandle) -> ClassicInfo {
  if let Some(version) = newest_classic(installed_classic(app).iter().map(String::as_str)) {
    return ClassicInfo { version: Some(version), installed: true, size_bytes: None };
  }
  let Ok(releases) = fetch_releases(app, false) else { return ClassicInfo::default(); };
  classic_from_releases(&releases, target_name().ok())
}

fn classic_from_releases(releases: &[Release], target: Option<&str>) -> ClassicInfo {
  let versions = releases.iter().filter_map(|r| r.tag_name.strip_prefix("game-v"));
  let Some(version) = newest_classic(versions) else { return ClassicInfo::default(); };
  let size_bytes = target.and_then(|target| {
    let name = format!("ahd-singleplayer-v{version}-{target}.tar.gz");
    releases.iter().find(|r| r.tag_name == format!("game-v{version}"))
      .and_then(|r| r.assets.iter().find(|a| a.name == name)).and_then(|a| a.size)
  });
  ClassicInfo { version: Some(version), installed: false, size_bytes }
}

pub fn list(app: &AppHandle) -> Result<Vec<GameVersion>, String> {
  let selected = selected(app);
  let versions_root = root(app)?;
  let mut available = BTreeSet::new();
  if let Ok(entries) = fs::read_dir(&versions_root) {
    for entry in entries.flatten() {
      let version = entry.file_name().to_string_lossy().to_string();
      if valid_version(&version) && entry.path().join("game/launch.mjs").is_file() {
        available.insert(version);
      }
    }
  }
  let mut sizes = std::collections::BTreeMap::new();
  if let Ok(releases) = fetch_releases(app, false) {
    let target = target_name().ok();
    for release in releases {
      let Some(version) = release.tag_name.strip_prefix("game-v").filter(|v| valid_version(v)).map(str::to_string) else { continue };
      if let Some(target) = target {
        let archive_name = format!("ahd-singleplayer-v{version}-{target}.tar.gz");
        if let Some(size) = release.assets.iter().find(|a| a.name == archive_name).and_then(|a| a.size) {
          sizes.insert(version.clone(), size);
        }
      }
      available.insert(version);
    }
  }
  let floor = app.path().app_data_dir().ok().and_then(|dir| newest_opened_version(&dir.join("worlds")));
  let mut versions = available.into_iter()
    .filter(|version| {
      let keep = selected.as_deref() == Some(version.as_str());
      keep || floor.is_none_or(|floor| parse_version(version).is_some_and(|v| v >= floor))
    })
    .map(|version| GameVersion {
      installed: versions_root.join(&version).join("game/launch.mjs").is_file(),
      selected: selected.as_deref() == Some(version.as_str()),
      size_bytes: sizes.get(&version).copied(),
      version,
    }).collect::<Vec<_>>();
  versions.sort_by(|a, b| parse_version(&b.version).cmp(&parse_version(&a.version)));
  Ok(versions)
}

fn release_asset(app: &AppHandle, version: &str) -> Result<(String, String), String> {
  let tag = format!("game-v{version}");
  let release = match fetch_releases(app, false)?.into_iter().find(|release| release.tag_name == tag) {
    Some(release) => release,
    None => fetch_releases(app, true)?.into_iter().find(|release| release.tag_name == tag)
      .ok_or_else(|| format!("Game {version} is not published."))?,
  };
  let archive_name = format!("ahd-singleplayer-v{version}-{}.tar.gz", target_name()?);
  let archive = release.assets.iter().find(|asset| asset.name == archive_name)
    .ok_or_else(|| format!("Game {version} is not available for this computer."))?;
  let checksum = release.assets.iter().find(|asset| asset.name == format!("{archive_name}.sha256"))
    .ok_or_else(|| format!("Game {version} is missing its checksum."))?;
  Ok((archive.browser_download_url.clone(), checksum.browser_download_url.clone()))
}

fn download(app: &AppHandle, version: &str, url: &str, destination: &Path) -> Result<(), String> {
  let response = ureq::AgentBuilder::new().timeout(Duration::from_secs(300)).build()
    .get(url).set("User-Agent", "AHDClient/2").call().map_err(|_| "Game download failed.".to_string())?;
  let total: Option<u64> = response.header("Content-Length").and_then(|v| v.parse().ok());
  let mut input = response.into_reader();
  let mut output = fs::File::create(destination).map_err(|e| e.to_string())?;
  let mut buffer = vec![0_u8; 256 * 1024];
  let (mut done, mut last_percent) = (0_u64, u64::MAX);
  loop {
    if CANCEL_DOWNLOAD.load(Ordering::SeqCst) { return Err("Download cancelled.".into()); }
    let read = input.read(&mut buffer).map_err(|_| "Game download failed.".to_string())?;
    if read == 0 { break; }
    output.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
    done += read as u64;
    let percent = total.filter(|t| *t > 0).map_or(0, |t| done * 100 / t);
    if percent != last_percent {
      last_percent = percent;
      let _ = app.emit("game:download", DownloadProgress { version: version.to_string(), downloaded: done, total });
    }
  }
  Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress { version: String, downloaded: u64, total: Option<u64> }

/// Ask a running `install` to stop at its next chunk.
pub fn cancel_download() { CANCEL_DOWNLOAD.store(true, Ordering::SeqCst); }

pub fn install(app: &AppHandle, version: &str) -> Result<(), String> {
  if !valid_version(version) { return Err("Only game versions 1.6.0 and newer are supported.".into()); }
  CANCEL_DOWNLOAD.store(false, Ordering::SeqCst);
  let (archive_url, checksum_url) = release_asset(app, version)?;
  let version_root = root(app)?.join(version);
  let staging = root(app)?.join(format!(".{version}.staging"));
  fs::create_dir_all(root(app)?).map_err(|e| e.to_string())?;
  if staging.exists() { fs::remove_dir_all(&staging).map_err(|e| e.to_string())?; }
  fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
  let archive = staging.join("game.tar.gz");
  if let Err(error) = download(app, version, &archive_url, &archive) {
    let _ = fs::remove_dir_all(&staging);
    return Err(error);
  }
  let expected = ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build()
    .get(&checksum_url).set("User-Agent", "AHDClient/2").call()
    .map_err(|_| "Could not verify the game download.".to_string())?.into_string()
    .map_err(|_| "Invalid game checksum.".to_string())?.split_whitespace().next().unwrap_or("").to_lowercase();
  let mut hasher = Sha256::new();
  let mut archive_file = fs::File::open(&archive).map_err(|e| e.to_string())?;
  let mut buffer = [0_u8; 64 * 1024];
  loop {
    let read = archive_file.read(&mut buffer).map_err(|e| e.to_string())?;
    if read == 0 { break; }
    hasher.update(&buffer[..read]);
  }
  if format!("{:x}", hasher.finalize()) != expected { return Err("Game download checksum did not match.".into()); }
  let unpacked = staging.join("unpacked");
  fs::create_dir_all(&unpacked).map_err(|e| e.to_string())?;
  let mut tar = tar::Archive::new(GzDecoder::new(fs::File::open(&archive).map_err(|e| e.to_string())?));
  tar.unpack(&unpacked).map_err(|_| "Game archive could not be safely extracted.".to_string())?;
  if !unpacked.join("game/launch.mjs").is_file() { return Err("Game archive is incomplete.".into()); }
  if version_root.exists() { fs::remove_dir_all(&version_root).map_err(|e| e.to_string())?; }
  fs::rename(&unpacked, &version_root).map_err(|e| e.to_string())?;
  let _ = fs::remove_dir_all(&staging);
  Ok(())
}

pub fn select(app: &AppHandle, version: Option<&str>) -> Result<(), String> {
  fs::create_dir_all(root(app)?).map_err(|e| e.to_string())?;
  match version {
    None => { let _ = fs::remove_file(selected_path(app)?); Ok(()) }
    Some(version) if valid_version(version) && root(app)?.join(version).join("game/launch.mjs").is_file() =>
      fs::write(selected_path(app)?, version).map_err(|e| e.to_string()),
    Some(_) => Err("Install that game version before selecting it.".into()),
  }
}

#[cfg(test)]
mod tests {
  use super::{cache_is_fresh, choose_runtime, classic_from_releases, is_classic_version, world_is_classic, Asset, Release, Runtime, newest_opened_version, parse_version, read_build_info, read_capabilities, target_name_for, valid_version};
  use std::fs;

  fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ahd-gv-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn capabilities_reader_returns_none_for_missing_or_bad_files() {
    let dir = temp_dir("caps");
    assert!(read_capabilities(&dir).is_none());
    fs::write(dir.join("singleplayer-capabilities.json"), "{ not json").unwrap();
    assert!(read_capabilities(&dir).is_none());
    fs::write(dir.join("singleplayer-capabilities.json"), "[1,2]").unwrap();
    assert!(read_capabilities(&dir).is_none());
    fs::write(dir.join("singleplayer-capabilities.json"), r#"{"schemaVersion":1}"#).unwrap();
    assert_eq!(read_capabilities(&dir).unwrap()["schemaVersion"], 1);
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn build_info_reader_tolerates_old_and_broken_files() {
    let dir = temp_dir("build");
    assert_eq!(read_build_info(&dir).game_version, None);
    fs::write(dir.join("AHD_BUILD.json"), r#"{"clientVersion":"2.10.0","gameCommit":null}"#).unwrap();
    let old = read_build_info(&dir);
    assert_eq!(old.game_version, None);
    assert_eq!(old.client_version.as_deref(), Some("2.10.0"));
    fs::write(dir.join("AHD_BUILD.json"), r#"{"gameVersion":"1.20.0","gameCommit":"abc"}"#).unwrap();
    assert_eq!(read_build_info(&dir).game_version.as_deref(), Some("1.20.0"));
    fs::write(dir.join("AHD_BUILD.json"), "garbage").unwrap();
    assert_eq!(read_build_info(&dir).game_version, None);
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn release_cache_lasts_one_hour() {
    assert!(cache_is_fresh(1000, 1000));
    assert!(cache_is_fresh(1000, 4599));
    assert!(!cache_is_fresh(1000, 4600));
    assert!(!cache_is_fresh(2000, 1000));
  }

  #[test]
  fn floor_is_newest_opened_version_and_skips_classic_worlds() {
    let dir = temp_dir("floor");
    assert_eq!(newest_opened_version(&dir), None);
    for (slot, body) in [
      ("a", r#"{"gameVersion":"1.19.2"}"#),
      ("b", r#"{"gameVersion":"1.20.0"}"#),
      ("c", r#"{"gameVersion":"1.8.3","classic":true}"#),
      ("d", r#"{"gameVersion":"1.30.0","classic":true}"#),
      ("e", r#"{"name":"no version"}"#),
      ("f", "garbage"),
    ] {
      fs::create_dir_all(dir.join(slot)).unwrap();
      fs::write(dir.join(slot).join("world.json"), body).unwrap();
    }
    assert_eq!(newest_opened_version(&dir), Some((1, 20, 0)));
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn accepts_only_complete_versions_at_or_after_1_6_0() {
    assert!(!valid_version("1.5.99"));
    assert!(valid_version("1.6.0"));
    assert!(valid_version("2.0.0"));
    assert!(!valid_version("1.6"));
    assert_eq!(parse_version("game-v1.6.3"), Some((1, 6, 3)));
  }

  #[test]
  fn maps_every_packaged_desktop_target_to_its_release_asset() {
    assert_eq!(target_name_for("windows", "x86_64"), Some("windows-x86_64"));
    assert_eq!(target_name_for("macos", "aarch64"), Some("macos-aarch64"));
    assert_eq!(target_name_for("macos", "x86_64"), Some("macos-x86_64"));
    assert_eq!(target_name_for("linux", "aarch64"), Some("linux-aarch64"));
    assert_eq!(target_name_for("linux", "x86_64"), Some("linux-x86_64"));
    assert_eq!(target_name_for("windows", "aarch64"), None);
  }

  fn installed(list: &[&str]) -> Vec<String> { list.iter().map(|v| v.to_string()).collect() }

  #[test]
  fn worlds_without_a_stamp_or_with_an_old_one_are_classic() {
    assert!(world_is_classic(None, false));
    assert!(world_is_classic(Some("1.19.4"), false));
    assert!(world_is_classic(Some("1.20.0"), true));
    assert!(!world_is_classic(Some("1.20.0"), false));
    assert!(!world_is_classic(Some("1.21.3"), false));
    assert!(is_classic_version("1.6.0") && !is_classic_version("1.20.0"));
  }

  #[test]
  fn a_plain_world_always_uses_the_current_runtime() {
    assert_eq!(choose_runtime(false, Some("1.20.0"), &[], None), Ok(Runtime::Current));
  }

  #[test]
  fn a_classic_world_uses_classic_and_never_the_newer_runtime() {
    let have = installed(&["1.18.0", "1.19.2"]);
    assert_eq!(choose_runtime(true, Some("1.20.0"), &have, None), Ok(Runtime::Classic("1.19.2".into())));
    assert_eq!(choose_runtime(true, Some("1.20.0"), &have, Some("1.18.0")), Ok(Runtime::Classic("1.18.0".into())));
    assert_eq!(choose_runtime(true, Some("1.20.0"), &have, Some("1.17.0")), Ok(Runtime::Classic("1.19.2".into())));
  }

  #[test]
  fn a_classic_world_without_classic_installed_asks_for_the_download() {
    let error = choose_runtime(true, Some("1.20.0"), &[], None).unwrap_err();
    assert!(error.starts_with("classic-required:"));
    assert!(choose_runtime(true, None, &[], None).is_err());
    // An app whose own game is still pre-1.20 can open Classic worlds itself.
    assert_eq!(choose_runtime(true, Some("1.19.0"), &[], None), Ok(Runtime::Current));
  }

  #[test]
  fn a_world_made_by_the_app_game_never_opens_on_an_older_download() {
    // 2.11.0: a new world stamped with the bundled 1.19.0 started on a
    // downloaded 1.8.3, which rejects autonomy v6.
    let have = installed(&["1.8.3"]);
    assert_eq!(choose_runtime(true, Some("1.19.0"), &have, Some("1.19.0")), Ok(Runtime::Current));
    assert_eq!(choose_runtime(true, Some("1.20.0"), &have, Some("1.19.0")).unwrap_err().starts_with("classic-required:"), true);
    // A world made on 1.8.3 still opens on 1.8.3.
    assert_eq!(choose_runtime(true, Some("1.19.0"), &have, Some("1.8.3")), Ok(Runtime::Classic("1.8.3".into())));
    // A newer installed Classic may open an older world.
    assert_eq!(choose_runtime(true, Some("1.20.0"), &installed(&["1.8.3", "1.19.2"]), Some("1.19.0")), Ok(Runtime::Classic("1.19.2".into())));
  }

  #[test]
  fn classic_release_is_the_newest_below_1_20() {
    let release = |tag: &str, size: u64| Release {
      tag_name: tag.into(),
      assets: vec![Asset { name: format!("ahd-singleplayer-v{}-linux-x86_64.tar.gz", &tag[6..]), browser_download_url: String::new(), size: Some(size) }],
    };
    let releases = vec![release("game-v1.20.0", 9), release("game-v1.19.1", 5), release("game-v1.19.3", 7), release("game-v1.8.0", 1)];
    let info = classic_from_releases(&releases, Some("linux-x86_64"));
    assert_eq!(info.version.as_deref(), Some("1.19.3"));
    assert_eq!(info.size_bytes, Some(7));
    assert!(!info.installed);
    assert_eq!(classic_from_releases(&releases[..1], None).version, None);
  }
}
