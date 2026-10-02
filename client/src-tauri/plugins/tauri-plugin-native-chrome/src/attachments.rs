use std::path::{Path, PathBuf};

use crate::{Error, Result};

/// Directory (under the temp dir) where the native pickers drop the files the
/// web side then reads. Files are named `<uuid>[.<ext>]`.
pub(crate) const ATTACHMENTS_DIR: &str = "anywh-attachments";

/// `8-4-4-4-12` hex, the shape `UUID().uuidString` produces.
fn is_uuid(stem: &str) -> bool {
  let bytes = stem.as_bytes();
  bytes.len() == 36
    && bytes.iter().enumerate().all(|(i, b)| match i {
      8 | 13 | 18 | 23 => *b == b'-',
      _ => b.is_ascii_hexdigit(),
    })
}

/// Resolves `requested` and accepts it only if it is a regular entry directly
/// inside `allowed_root` with a UUID name. Both sides are canonicalized, so a
/// `..` segment or a symlink pointing elsewhere resolves outside the root and
/// is refused. This keeps `read_attachment` from being an arbitrary disk read.
pub(crate) fn validate_attachment_path(allowed_root: &Path, requested: &Path) -> Result<PathBuf> {
  let root = allowed_root.canonicalize()?;
  let resolved = requested.canonicalize()?;
  let in_root = resolved.parent() == Some(root.as_path());
  let uuid_named = resolved
    .file_stem()
    .and_then(|stem| stem.to_str())
    .is_some_and(is_uuid);
  if in_root && uuid_named && resolved.is_file() {
    Ok(resolved)
  } else {
    Err(Error::InvalidAttachmentPath)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  const UUID: &str = "3f2b8c1e-9a4d-4e57-8b21-0c6d5a7e1f90";

  fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("anywh-attachments-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn accepts_a_uuid_file_inside_the_root() {
    let root = scratch("ok");
    let file = root.join(format!("{UUID}.mov"));
    fs::write(&file, b"x").unwrap();
    assert!(validate_attachment_path(&root, &file).is_ok());
    fs::remove_dir_all(&root).unwrap();
  }

  #[test]
  fn accepts_a_uuid_file_without_extension() {
    let root = scratch("noext");
    let file = root.join(UUID);
    fs::write(&file, b"x").unwrap();
    assert!(validate_attachment_path(&root, &file).is_ok());
    fs::remove_dir_all(&root).unwrap();
  }

  #[test]
  fn refuses_dot_dot_escapes() {
    let root = scratch("dotdot");
    let outside = root.parent().unwrap().join(format!("{UUID}.txt"));
    fs::write(&outside, b"x").unwrap();
    let sneaky = root.join("..").join(format!("{UUID}.txt"));
    assert!(validate_attachment_path(&root, &sneaky).is_err());
    fs::remove_file(&outside).unwrap();
    fs::remove_dir_all(&root).unwrap();
  }

  #[cfg(unix)]
  #[test]
  fn refuses_a_symlink_pointing_outside() {
    let root = scratch("symlink");
    let target = scratch("symlink-target").join("secret.txt");
    fs::write(&target, b"x").unwrap();
    let link = root.join(format!("{UUID}.txt"));
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(validate_attachment_path(&root, &link).is_err());
    fs::remove_dir_all(&root).unwrap();
    fs::remove_dir_all(target.parent().unwrap()).unwrap();
  }

  #[test]
  fn refuses_another_directory() {
    let root = scratch("root");
    let other = scratch("other");
    let file = other.join(format!("{UUID}.png"));
    fs::write(&file, b"x").unwrap();
    assert!(validate_attachment_path(&root, &file).is_err());
    fs::remove_dir_all(&root).unwrap();
    fs::remove_dir_all(&other).unwrap();
  }

  #[test]
  fn refuses_a_non_uuid_name_and_nested_paths() {
    let root = scratch("names");
    let named = root.join("passwd");
    fs::write(&named, b"x").unwrap();
    assert!(validate_attachment_path(&root, &named).is_err());
    let nested_dir = root.join("sub");
    fs::create_dir_all(&nested_dir).unwrap();
    let nested = nested_dir.join(format!("{UUID}.png"));
    fs::write(&nested, b"x").unwrap();
    assert!(validate_attachment_path(&root, &nested).is_err());
    fs::remove_dir_all(&root).unwrap();
  }

  #[test]
  fn refuses_a_missing_file() {
    let root = scratch("missing");
    assert!(validate_attachment_path(&root, &root.join(format!("{UUID}.png"))).is_err());
    fs::remove_dir_all(&root).unwrap();
  }
}
