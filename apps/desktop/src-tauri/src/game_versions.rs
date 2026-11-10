use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, io::{self, Read}, path::{Path, PathBuf}, time::Duration};
use tauri::{AppHandle, Manager};

const RELEASES_URL: &str = "https://api.github.com/repos/Egg3901/AHDGame/releases?per_page=50";
const MIN_VERSION: (u64, u64, u64) = (1, 6, 0);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameVersion {
  pub version: String,
  pub installed: bool,
  pub selected: bool,
}

#[derive(Deserialize)]
struct Release { tag_name: String, assets: Vec<Asset> }

#[derive(Deserialize)]
struct Asset { name: String, browser_download_url: String }

fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
  let value = value.trim().trim_start_matches("game-v").trim_start_matches('v');
  let mut pieces = value.split('.');
  let parsed = (pieces.next()?.parse().ok()?, pieces.next()?.parse().ok()?, pieces.next()?.parse().ok()?);
  if pieces.next().is_some() { return None; }
  Some(parsed)
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

fn fetch_releases() -> Result<Vec<Release>, String> {
  ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build()
    .get(RELEASES_URL).set("User-Agent", "AHDClient/2").call()
    .map_err(|_| "Cannot check game versions. Connect to the internet and try again.".to_string())?
    .into_json().map_err(|_| "GitHub returned an invalid game release list.".to_string())
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
  if let Ok(releases) = fetch_releases() {
    available.extend(releases.into_iter().filter_map(|release| {
      release.tag_name.strip_prefix("game-v").filter(|version| valid_version(version)).map(str::to_string)
    }));
  }
  let mut versions = available.into_iter().map(|version| {
    GameVersion {
      installed: versions_root.join(&version).join("game/launch.mjs").is_file(),
      selected: selected.as_deref() == Some(version.as_str()),
      version,
    }
  }).collect::<Vec<_>>();
  versions.sort_by(|a, b| parse_version(&b.version).cmp(&parse_version(&a.version)));
  Ok(versions)
}

fn release_asset(version: &str) -> Result<(String, String), String> {
  let release = fetch_releases()?.into_iter().find(|release| release.tag_name == format!("game-v{version}"))
    .ok_or_else(|| format!("Game {version} is not published."))?;
  let archive_name = format!("ahd-singleplayer-v{version}-{}.tar.gz", target_name()?);
  let archive = release.assets.iter().find(|asset| asset.name == archive_name)
    .ok_or_else(|| format!("Game {version} is not available for this computer."))?;
  let checksum = release.assets.iter().find(|asset| asset.name == format!("{archive_name}.sha256"))
    .ok_or_else(|| format!("Game {version} is missing its checksum."))?;
  Ok((archive.browser_download_url.clone(), checksum.browser_download_url.clone()))
}

fn download(url: &str, destination: &Path) -> Result<(), String> {
  let response = ureq::AgentBuilder::new().timeout(Duration::from_secs(300)).build()
    .get(url).set("User-Agent", "AHDClient/2").call().map_err(|_| "Game download failed.".to_string())?;
  let mut input = response.into_reader();
  let mut output = fs::File::create(destination).map_err(|e| e.to_string())?;
  io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
  Ok(())
}

pub fn install(app: &AppHandle, version: &str) -> Result<(), String> {
  if !valid_version(version) { return Err("Only game versions 1.6.0 and newer are supported.".into()); }
  let (archive_url, checksum_url) = release_asset(version)?;
  let version_root = root(app)?.join(version);
  let staging = root(app)?.join(format!(".{version}.staging"));
  fs::create_dir_all(root(app)?).map_err(|e| e.to_string())?;
  if staging.exists() { fs::remove_dir_all(&staging).map_err(|e| e.to_string())?; }
  fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
  let archive = staging.join("game.tar.gz");
  download(&archive_url, &archive)?;
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
  use super::{parse_version, read_build_info, read_capabilities, target_name_for, valid_version};
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
}
