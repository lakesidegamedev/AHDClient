//! Open straight into the game (mobile).
//!
//! The launcher stays the first page, but a signed-in player who has not
//! turned the setting off is taken to the live site as the app starts, back to
//! the page they were last reading when one is saved. Everything that decides
//! is a pure function here so Android reuses it unchanged; the platform code
//! only supplies facts (is there a session, did a link open the app) and does
//! the navigation.
//!
//! Two small files live in the app data directory:
//! - `launch.json`, written by Rust when the Settings switch changes.
//! - `last-game.json`, written by the platform shell (iOS today): the last
//!   game page and the fingerprint of the session that read it.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const SETTING_FILE: &str = "launch.json";
const LAST_GAME_FILE: &str = "last-game.json";
/// Same bound the native shells apply to a game path.
const MAX_PATH_BYTES: usize = 300;
const MAX_FILE_BYTES: u64 = 4096;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Setting {
  open_game_on_start: bool,
}

#[derive(Deserialize)]
struct LastGame {
  path: String,
  account: String,
}

/// Open the game on start only when the player wants it, has a session, and
/// no widget, alert or other link already chose where the app should go.
pub(crate) fn should_auto_open(setting: bool, signed_in: bool, launch_link: bool) -> bool {
  setting && signed_in && !launch_link
}

/// The saved page, if it is safe to restore for this session. Only a plain
/// path on the live site qualifies, and never a sign-in or sign-out page
/// (restoring one could loop), an API route, or a page saved by a different
/// session.
pub(crate) fn restore_path(saved: &str, saved_account: &str, account: &str) -> Option<String> {
  if saved_account.is_empty() || saved_account != account { return None; }
  safe_game_path(saved).then(|| saved.to_string())
}

fn safe_game_path(path: &str) -> bool {
  if path.len() > MAX_PATH_BYTES || !path.starts_with('/') || path.starts_with("//") { return false; }
  if path.contains('\\') || path.chars().any(|c| c.is_whitespace() || c.is_control()) { return false; }
  let route = path.split(['?', '#']).next().unwrap_or("");
  let first = route.trim_start_matches('/').split('/').next().unwrap_or("");
  !matches!(first, "login" | "register" | "logout" | "signin" | "signout" | "auth" | "api" | "client")
}

/// The same fingerprint the iOS shell keys its per-account caches on.
pub(crate) fn session_fingerprint(header: &str) -> Option<String> {
  if header.is_empty() { return None; }
  Some(Sha256::digest(header.as_bytes()).iter().map(|b| format!("{b:02x}")).collect())
}

fn dir(app: &AppHandle) -> Option<PathBuf> { app.path().app_data_dir().ok() }

fn read_bounded(path: PathBuf) -> Option<Vec<u8>> {
  if std::fs::metadata(&path).ok()?.len() > MAX_FILE_BYTES { return None; }
  std::fs::read(path).ok()
}

/// Defaults to on until the player says otherwise.
pub(crate) fn open_game_on_start(app: &AppHandle) -> bool {
  dir(app)
    .and_then(|dir| read_bounded(dir.join(SETTING_FILE)))
    .and_then(|bytes| serde_json::from_slice::<Setting>(&bytes).ok())
    .map(|saved| saved.open_game_on_start)
    .unwrap_or(true)
}

/// The page to restore for `account`, if the shell saved a usable one.
pub(crate) fn saved_game_path(app: &AppHandle, account: &str) -> Option<String> {
  let saved: LastGame = serde_json::from_slice(&read_bounded(dir(app)?.join(LAST_GAME_FILE))?).ok()?;
  restore_path(&saved.path, &saved.account, account)
}

#[tauri::command]
pub(crate) async fn set_open_game_on_start(app: AppHandle, enabled: bool) -> Result<(), String> {
  const FAILED: &str = "Cannot save this setting.";
  let path = dir(&app).ok_or(FAILED)?.join(SETTING_FILE);
  if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|_| FAILED)?; }
  let temporary = path.with_extension("tmp");
  let bytes = serde_json::to_vec(&Setting { open_game_on_start: enabled }).map_err(|_| FAILED)?;
  std::fs::write(&temporary, bytes).and_then(|_| std::fs::rename(&temporary, &path)).map_err(|_| FAILED.into())
}

#[cfg(test)]
mod tests {
  use super::{restore_path, safe_game_path, session_fingerprint, should_auto_open};

  #[test]
  fn auto_open_needs_the_setting_a_session_and_no_launch_link() {
    assert!(should_auto_open(true, true, false));
    assert!(!should_auto_open(false, true, false));
    assert!(!should_auto_open(true, false, false));
    assert!(!should_auto_open(true, true, true));
    assert!(!should_auto_open(false, false, true));
  }

  #[test]
  fn restores_only_a_plain_game_page_for_the_same_session() {
    assert_eq!(restore_path("/country/fr", "abc", "abc").as_deref(), Some("/country/fr"));
    assert_eq!(restore_path("/map?layer=trade#top", "abc", "abc").as_deref(), Some("/map?layer=trade#top"));
    assert_eq!(restore_path("/country/fr", "abc", "other"), None);
    assert_eq!(restore_path("/country/fr", "", ""), None);
  }

  #[test]
  fn never_restores_pages_that_could_loop_or_leave_the_site() {
    for path in ["/login", "/login?next=%2F", "/register", "/logout", "/auth/callback", "/api/state", "/client/link",
      "//evil.example/", "https://evil.example/", "country/fr", "/a b", "/a\\b", "/a\nb", ""] {
      assert!(!safe_game_path(path), "{path:?} must not be restored");
    }
    assert!(!safe_game_path(&format!("/{}", "a".repeat(300))));
    assert!(safe_game_path("/loginfo"));
  }

  #[test]
  fn fingerprint_matches_the_native_sha256_hex_and_is_empty_signed_out() {
    assert_eq!(session_fingerprint(""), None);
    assert_eq!(session_fingerprint("a").map(|f| f.len()), Some(64));
    assert_eq!(
      session_fingerprint("abc").as_deref(),
      Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    );
  }
}
