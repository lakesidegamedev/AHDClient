//! Files the game page asks to download (chart images and the like) go to the
//! player's Downloads folder under a name that never replaces an existing file.

use std::path::{Path, PathBuf};

use tauri::Url;

const MAX_NAME: usize = 120;

/// Only files the game page itself produces: a blob or data URL made by the
/// page, or a file served by the game's own address. Anything else is refused.
pub(crate) fn download_allowed(url: &Url, same_origin: bool) -> bool {
  matches!(url.scheme(), "blob" | "data") || same_origin
}

/// A file name that is safe on every OS: no folders, no reserved characters.
pub(crate) fn safe_file_name(suggested: &Path) -> String {
  let raw = suggested.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  let cleaned: String = raw
    .chars()
    .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
    .collect();
  let cleaned = cleaned.trim().trim_matches('.').trim().to_string();
  let cleaned: String = cleaned.chars().take(MAX_NAME).collect();
  if cleaned.is_empty() { "download".to_string() } else { cleaned }
}

/// `dir/name`, or `dir/name (2).ext`, `(3)` and so on, until `exists` says
/// the path is free.
pub(crate) fn unique_path(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
  let first = dir.join(name);
  if !exists(&first) { return first; }
  let path = Path::new(name);
  let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.to_string());
  let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
  let mut n = 2u32;
  loop {
    let candidate = dir.join(format!("{stem} ({n}){ext}"));
    if !exists(&candidate) || n > 9999 { return candidate; }
    n += 1;
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_lose_folders_and_reserved_characters() {
    assert_eq!(safe_file_name(Path::new("/tmp/../chart.png")), "chart.png");
    assert_eq!(safe_file_name(Path::new("a:b*c.png")), "a_b_c.png");
    assert_eq!(safe_file_name(Path::new("")), "download");
    assert_eq!(safe_file_name(Path::new("..")), "download");
  }

  #[test]
  fn a_taken_name_gets_a_number_and_is_never_reused() {
    let taken = [PathBuf::from("/d/chart.png"), PathBuf::from("/d/chart (2).png")];
    let path = unique_path(Path::new("/d"), "chart.png", |p| taken.iter().any(|t| t == p));
    assert_eq!(path, PathBuf::from("/d/chart (3).png"));
    assert_eq!(unique_path(Path::new("/d"), "new.png", |_| false), PathBuf::from("/d/new.png"));
  }

  #[test]
  fn only_page_made_or_own_origin_files_are_allowed() {
    let blob: Url = "blob:http://127.0.0.1:3111/abc".parse().unwrap();
    let other: Url = "https://example.com/x.exe".parse().unwrap();
    assert!(download_allowed(&blob, false));
    assert!(!download_allowed(&other, false));
    assert!(download_allowed(&other, true));
  }
}
