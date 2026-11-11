//! Settings that live in the operating system rather than in the page:
//! starting with the computer, the data folder and what it holds, and the
//! native half of "Reset settings".
use std::path::Path;

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

/// Total size in bytes of every file under `dir`. Unreadable entries count as
/// zero, symlinks are not followed, and a missing folder is empty.
pub(crate) fn folder_bytes(dir: &Path) -> u64 {
  let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
  entries
    .flatten()
    .map(|entry| match entry.file_type() {
      Ok(kind) if kind.is_dir() => folder_bytes(&entry.path()),
      Ok(kind) if kind.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
      _ => 0,
    })
    .sum()
}

#[tauri::command]
pub(crate) fn get_autostart(app: AppHandle) -> Result<bool, String> {
  app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
  let manager = app.autolaunch();
  if enabled { manager.enable() } else { manager.disable() }.map_err(|e| e.to_string())?;
  manager.is_enabled().map_err(|e| e.to_string())
}

/// Where the local game keeps its worlds, and how much room they take.
#[tauri::command]
pub(crate) fn data_folder_info(app: AppHandle) -> Result<serde_json::Value, String> {
  let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let worlds = root.join("worlds");
  Ok(serde_json::json!({ "worldsBytes": folder_bytes(&worlds), "totalBytes": folder_bytes(&root) }))
}

#[tauri::command]
pub(crate) fn open_data_folder(app: AppHandle) -> Result<(), String> {
  let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&root).map_err(|_| "Cannot open the data folder.".to_string())?;
  app.opener().open_path(root.to_string_lossy().to_string(), None::<&str>).map_err(|_| "Cannot open the data folder.".to_string())
}

/// Puts the settings the shell keeps outside the page back to their defaults:
/// start on sign-in off, keep-in-tray off, game zoom 100 percent. Worlds,
/// saves, the linked account and alert subscriptions are not touched.
#[tauri::command]
pub(crate) fn reset_native_settings(app: AppHandle) -> Result<(), String> {
  let manager = app.autolaunch();
  if manager.is_enabled().unwrap_or(false) { manager.disable().map_err(|e| e.to_string())?; }
  crate::tray::reset(&app);
  crate::desktop_alerts::reset_reminder(&app);
  if let Some(path) = crate::desktop::zoom_file(&app) { let _ = std::fs::remove_file(path); }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::folder_bytes;

  #[test]
  fn counts_nested_files_and_treats_a_missing_folder_as_empty() {
    let root = std::env::temp_dir().join(format!("ahd-folder-bytes-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("a/b")).unwrap();
    std::fs::write(root.join("one"), [0u8; 10]).unwrap();
    std::fs::write(root.join("a/two"), [0u8; 5]).unwrap();
    std::fs::write(root.join("a/b/three"), [0u8; 7]).unwrap();
    assert_eq!(folder_bytes(&root), 22);
    assert_eq!(folder_bytes(&root.join("missing")), 0);
    let _ = std::fs::remove_dir_all(&root);
  }
}
