//! World export and import: one `.ahdworld` file is a gzip-compressed tar of a
//! world folder. Pure file work, no app state, so it is tested on its own.

use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

/// Never packed: per-process files that mean nothing on another computer.
const SKIP: [&str; 3] = [".ahdclient.lock", "world.json.tmp", "restore-pending.json"];

/// Upper bound on what an import may unpack, so a hostile or broken file
/// cannot fill the disk.
const MAX_UNPACKED: u64 = 200 * 1024 * 1024 * 1024;

fn collect(dir: &Path, rel: &Path, out: &mut Vec<(PathBuf, PathBuf)>) -> Result<(), String> {
  for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
    let name = entry.file_name();
    let rel_path = rel.join(&name);
    if rel.as_os_str().is_empty() && SKIP.iter().any(|s| name == *s) {
      continue;
    }
    let kind = entry.file_type().map_err(|e| e.to_string())?;
    if kind.is_dir() {
      collect(&entry.path(), &rel_path, out)?;
    } else if kind.is_file() {
      out.push((entry.path(), rel_path));
    }
  }
  Ok(())
}

/// Pack `world` into `dest`. `meta_json` replaces `world.json` in the archive
/// so the archive always carries the current version and Classic stamp.
pub fn export_world(world: &Path, dest: &Path, meta_json: &[u8]) -> Result<(), String> {
  let mut files = Vec::new();
  collect(world, Path::new(""), &mut files)?;
  files.retain(|(_, rel)| rel != Path::new("world.json"));
  let tmp = dest.with_extension("ahdworld.part");
  let result = (|| -> Result<(), String> {
    let file = File::create(&tmp).map_err(|e| format!("Cannot write the file: {e}"))?;
    let mut tar = tar::Builder::new(GzEncoder::new(BufWriter::new(file), Compression::fast()));
    let mut header = tar::Header::new_gnu();
    header.set_size(meta_json.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "world.json", meta_json).map_err(|e| e.to_string())?;
    for (path, rel) in &files {
      tar.append_path_with_name(path, rel).map_err(|e| e.to_string())?;
    }
    let encoder = tar.into_inner().map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())?;
    Ok(())
  })();
  match result {
    Ok(()) => fs::rename(&tmp, dest).map_err(|e| format!("Cannot write the file: {e}")),
    Err(e) => {
      let _ = fs::remove_file(&tmp);
      Err(e)
    }
  }
}

/// Unpack an archive into the empty directory `staging` and return its
/// `world.json` bytes. Only plain files and folders are accepted, every path
/// stays inside `staging`, and total size is capped.
pub fn unpack_world(archive: &Path, staging: &Path) -> Result<Vec<u8>, String> {
  const NOT_A_WORLD: &str = "That file is not an AHD world.";
  let file = File::open(archive).map_err(|e| format!("Cannot read the file: {e}"))?;
  let mut tar = tar::Archive::new(GzDecoder::new(file));
  let mut total: u64 = 0;
  for entry in tar.entries().map_err(|_| NOT_A_WORLD.to_string())? {
    let mut entry = entry.map_err(|_| NOT_A_WORLD.to_string())?;
    let kind = entry.header().entry_type();
    let path = entry.path().map_err(|_| NOT_A_WORLD.to_string())?.into_owned();
    let mut target = staging.to_path_buf();
    let mut any = false;
    for part in path.components() {
      match part {
        Component::Normal(p) => {
          target.push(p);
          any = true;
        }
        Component::CurDir => {}
        _ => return Err(NOT_A_WORLD.into()),
      }
    }
    if !any {
      continue;
    }
    if kind.is_dir() {
      fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    } else if kind.is_file() {
      total = total.saturating_add(entry.size());
      if total > MAX_UNPACKED {
        return Err("That world file is too large.".into());
      }
      if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
      }
      entry.unpack(&target).map_err(|e| format!("Cannot unpack the world: {e}"))?;
    } else {
      return Err(NOT_A_WORLD.into());
    }
  }
  fs::read(staging.join("world.json")).map_err(|_| NOT_A_WORLD.to_string())
}

/// Total bytes of every file under `dir`.
pub fn dir_size(dir: &Path) -> u64 {
  fs::read_dir(dir)
    .into_iter()
    .flatten()
    .flatten()
    .map(|entry| match entry.file_type() {
      Ok(t) if t.is_dir() => dir_size(&entry.path()),
      Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
      _ => 0,
    })
    .sum()
}

/// The first of `base`, `base-2`, `base-3`... that is not a folder in `worlds`.
/// Import never writes into an existing world.
pub fn free_slot(worlds: &Path, base: &str) -> String {
  if !worlds.join(base).exists() {
    return base.to_string();
  }
  let stem: String = base.chars().take(58).collect();
  (2u32..)
    .map(|n| format!("{stem}-{n}"))
    .find(|slot| !worlds.join(slot).exists())
    .expect("an unused slot exists")
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ahd-archive-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn a_world_round_trips_with_its_stamp_and_skips_process_files() {
    let root = scratch("round");
    let world = root.join("w");
    fs::create_dir_all(world.join("db")).unwrap();
    fs::create_dir_all(world.join("saves/a")).unwrap();
    fs::write(world.join("db/data"), b"data").unwrap();
    fs::write(world.join("saves/a/save.json"), b"{}").unwrap();
    fs::write(world.join(".ahdclient.lock"), b"").unwrap();
    fs::write(world.join("restore-pending.json"), b"{}").unwrap();
    fs::write(world.join("world.json"), b"old").unwrap();
    let meta = br#"{"gameVersion":"1.8.3","classic":true}"#;
    let file = root.join("w.ahdworld");
    export_world(&world, &file, meta).unwrap();

    let staging = root.join("in");
    fs::create_dir_all(&staging).unwrap();
    assert_eq!(unpack_world(&file, &staging).unwrap(), meta.to_vec());
    assert_eq!(fs::read(staging.join("db/data")).unwrap(), b"data");
    assert!(staging.join("saves/a/save.json").is_file());
    assert!(!staging.join(".ahdclient.lock").exists());
    assert!(!staging.join("restore-pending.json").exists());
    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn files_that_are_not_worlds_are_refused() {
    let root = scratch("bad");
    let junk = root.join("junk.ahdworld");
    fs::write(&junk, b"not an archive").unwrap();
    let staging = root.join("in");
    fs::create_dir_all(&staging).unwrap();
    assert!(unpack_world(&junk, &staging).unwrap_err().contains("not an AHD world"));

    // A valid archive with no world.json is not a world either.
    let file = root.join("nometa.ahdworld");
    let mut tar = tar::Builder::new(GzEncoder::new(File::create(&file).unwrap(), Compression::fast()));
    let mut header = tar::Header::new_gnu();
    header.set_size(1);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "other.txt", &b"x"[..]).unwrap();
    tar.into_inner().unwrap().finish().unwrap();
    assert!(unpack_world(&file, &staging).unwrap_err().contains("not an AHD world"));
    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn paths_that_climb_out_of_the_world_are_refused() {
    let root = scratch("climb");
    let file = root.join("evil.ahdworld");
    // Build the raw header by hand: the tar builder itself refuses `..`.
    let mut raw = vec![0u8; 512];
    raw[..13].copy_from_slice(b"../escape.txt");
    raw[100..107].copy_from_slice(b"0000644");
    raw[124..135].copy_from_slice(b"00000000001");
    raw[156] = b'0';
    raw[257..263].copy_from_slice(b"ustar\0");
    raw[148..156].copy_from_slice(b"        ");
    let sum: u32 = raw.iter().map(|b| *b as u32).sum();
    raw[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
    let mut body = raw;
    let mut data = vec![0u8; 512];
    data[0] = b'x';
    body.extend(data);
    body.extend(vec![0u8; 1024]);
    let mut enc = GzEncoder::new(File::create(&file).unwrap(), Compression::fast());
    std::io::Write::write_all(&mut enc, &body).unwrap();
    enc.finish().unwrap();
    let staging = root.join("in");
    fs::create_dir_all(&staging).unwrap();
    assert!(unpack_world(&file, &staging).is_err());
    assert!(!root.join("escape.txt").exists());
    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn import_picks_a_free_slot_and_never_reuses_one() {
    let root = scratch("slots");
    assert_eq!(free_slot(&root, "cold-war"), "cold-war");
    fs::create_dir_all(root.join("cold-war")).unwrap();
    assert_eq!(free_slot(&root, "cold-war"), "cold-war-2");
    fs::create_dir_all(root.join("cold-war-2")).unwrap();
    assert_eq!(free_slot(&root, "cold-war"), "cold-war-3");
    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn size_counts_every_file() {
    let root = scratch("size");
    fs::create_dir_all(root.join("a/b")).unwrap();
    fs::write(root.join("x"), b"123").unwrap();
    fs::write(root.join("a/b/y"), b"4567").unwrap();
    assert_eq!(dir_size(&root), 7);
    let _ = fs::remove_dir_all(root);
  }
}
