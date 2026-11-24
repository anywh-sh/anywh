//! One-time move of macOS WebKit storage onto the app's real bundle id.
//!
//! WKWebView keys its data store (localStorage — where the profile list
//! lives — IndexedDB, and so on) by the running bundle's
//! `CFBundleIdentifier`, under `~/Library/WebKit/<bundle id>`. Every 0.2.x
//! release up to the ENG-95 fix shipped an Info.plist carrying the
//! checked-in development identifier (the build passed the official one to
//! the compiler but not to the bundler), so those installs kept their
//! WebKit data under the development id. Once the plist carries the official
//! id, WebKit looks in a different directory and the app would open to an
//! empty profile list — so, before the first webview exists, the old
//! directory is copied over.
//!
//! Copied, not moved: a `tauri dev` build on the same Mac still runs as the
//! development id and keeps using that directory. Anything already under the
//! official id (left by a 0.1.x install, before the identifier came from the
//! build environment) is older than what the user last saw in 0.2.x, so it
//! is set aside rather than merged — WebKit salts per-store file names, so a
//! merge would not be readable anyway. A marker file makes this run once per
//! install: without it, a later dev build recreating the old directory would
//! be copied over the release's data on the next launch.
//!
//! Only the call site is macOS-specific; the logic is plain filesystem work,
//! tested on every platform.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The identifier `tauri.conf.json` carries and the 0.2.x macOS releases
/// shipped in their Info.plist.
pub const LEGACY_IDENTIFIER: &str = "dev.anywh.local";

/// Written inside the official id's WebKit directory once the check ran.
const MARKER: &str = ".anywh-webkit-migrated";

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The app already runs as the legacy id (a dev build): nothing to do.
    SameIdentifier,
    /// A previous launch already ran the check.
    AlreadyDone,
    /// No legacy data on this machine; marked so it is never copied later.
    NothingToMigrate,
    /// Legacy data copied; `set_aside` is where older data under the
    /// official id went, if there was any.
    Migrated { set_aside: Option<PathBuf> },
}

/// Runs the migration against the user's real `~/Library/WebKit`, logging
/// instead of failing: a launch must never be blocked by it.
#[cfg(target_os = "macos")]
pub fn run(identifier: &str) {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let webkit_root = PathBuf::from(home).join("Library").join("WebKit");
    match migrate(&webkit_root, LEGACY_IDENTIFIER, identifier, unix_now()) {
        Ok(Outcome::Migrated { set_aside }) => eprintln!(
            "webkit-migration: copied WebKit data from {LEGACY_IDENTIFIER} to {identifier} (older data set aside: {set_aside:?})"
        ),
        Ok(_) => {}
        Err(err) => eprintln!("webkit-migration: failed, continuing with current data: {err}"),
    }
}

#[cfg(target_os = "macos")]
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `webkit_root` is `~/Library/WebKit`; `stamp` only names the set-aside
/// directory.
pub fn migrate(
    webkit_root: &Path,
    legacy_id: &str,
    identifier: &str,
    stamp: u64,
) -> io::Result<Outcome> {
    if legacy_id == identifier {
        return Ok(Outcome::SameIdentifier);
    }
    let target = webkit_root.join(identifier);
    if target.join(MARKER).exists() {
        return Ok(Outcome::AlreadyDone);
    }

    let legacy = webkit_root.join(legacy_id);
    if !legacy.is_dir() {
        fs::create_dir_all(&target)?;
        fs::write(target.join(MARKER), b"")?;
        return Ok(Outcome::NothingToMigrate);
    }

    // Copy into a staging directory first and rename it into place, so an
    // interrupted copy (crash, disk full) never leaves a half-populated
    // store under the official id; the next launch just tries again.
    let staging = webkit_root.join(format!("{identifier}.migrating"));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    copy_dir(&legacy, &staging)?;
    fs::write(staging.join(MARKER), b"")?;

    let set_aside = if target.exists() {
        let aside = webkit_root.join(format!("{identifier}.before-migration-{stamp}"));
        fs::rename(&target, &aside)?;
        Some(aside)
    } else {
        None
    };
    fs::rename(&staging, &target)?;
    Ok(Outcome::Migrated { set_aside })
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &dest)?;
        }
        // Symlinks and sockets are not part of a WebKit store; skipped.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: &str = "sh.example.app";

    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("anywh-webkit-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempRoot(dir)
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn local_storage(root: &Path, id: &str) -> PathBuf {
        root.join(id)
            .join("WebsiteData/Default/abc/abc/LocalStorage/localstorage.sqlite3")
    }

    #[test]
    fn copies_legacy_store_and_keeps_the_original() {
        let root = TempRoot::new("copy");
        write(&local_storage(&root.0, LEGACY_IDENTIFIER), "profiles-v2");
        write(
            &root
                .0
                .join(LEGACY_IDENTIFIER)
                .join("WebsiteData/Default/salt"),
            "salt",
        );

        let out = migrate(&root.0, LEGACY_IDENTIFIER, NEW, 1).unwrap();

        assert_eq!(out, Outcome::Migrated { set_aside: None });
        assert_eq!(
            fs::read_to_string(local_storage(&root.0, NEW)).unwrap(),
            "profiles-v2"
        );
        assert_eq!(
            fs::read_to_string(root.0.join(NEW).join("WebsiteData/Default/salt")).unwrap(),
            "salt"
        );
        assert!(
            local_storage(&root.0, LEGACY_IDENTIFIER).exists(),
            "dev builds keep their data"
        );
        assert!(!root.0.join(format!("{NEW}.migrating")).exists());
    }

    #[test]
    fn sets_older_official_data_aside_instead_of_merging() {
        let root = TempRoot::new("aside");
        write(&local_storage(&root.0, LEGACY_IDENTIFIER), "profiles-0.2");
        write(&local_storage(&root.0, NEW), "profiles-0.1");

        let out = migrate(&root.0, LEGACY_IDENTIFIER, NEW, 42).unwrap();

        let aside = root.0.join(format!("{NEW}.before-migration-42"));
        assert_eq!(
            out,
            Outcome::Migrated {
                set_aside: Some(aside.clone())
            }
        );
        assert_eq!(
            fs::read_to_string(local_storage(&root.0, NEW)).unwrap(),
            "profiles-0.2"
        );
        assert_eq!(
            fs::read_to_string(
                aside.join("WebsiteData/Default/abc/abc/LocalStorage/localstorage.sqlite3")
            )
            .unwrap(),
            "profiles-0.1"
        );
    }

    #[test]
    fn runs_once_even_if_legacy_data_appears_later() {
        let root = TempRoot::new("once");
        write(&local_storage(&root.0, LEGACY_IDENTIFIER), "first");
        migrate(&root.0, LEGACY_IDENTIFIER, NEW, 1).unwrap();
        write(&local_storage(&root.0, NEW), "used-by-release");
        write(
            &local_storage(&root.0, LEGACY_IDENTIFIER),
            "later-dev-build",
        );

        assert_eq!(
            migrate(&root.0, LEGACY_IDENTIFIER, NEW, 2).unwrap(),
            Outcome::AlreadyDone
        );
        assert_eq!(
            fs::read_to_string(local_storage(&root.0, NEW)).unwrap(),
            "used-by-release"
        );
    }

    #[test]
    fn marks_a_machine_without_legacy_data() {
        let root = TempRoot::new("none");
        write(&local_storage(&root.0, NEW), "fresh");

        assert_eq!(
            migrate(&root.0, LEGACY_IDENTIFIER, NEW, 1).unwrap(),
            Outcome::NothingToMigrate
        );
        write(
            &local_storage(&root.0, LEGACY_IDENTIFIER),
            "later-dev-build",
        );
        assert_eq!(
            migrate(&root.0, LEGACY_IDENTIFIER, NEW, 2).unwrap(),
            Outcome::AlreadyDone
        );
        assert_eq!(
            fs::read_to_string(local_storage(&root.0, NEW)).unwrap(),
            "fresh"
        );
    }

    #[test]
    fn discards_a_stale_staging_dir_from_an_interrupted_run() {
        let root = TempRoot::new("staging");
        write(&local_storage(&root.0, LEGACY_IDENTIFIER), "profiles");
        write(
            &root.0.join(format!("{NEW}.migrating")).join("junk"),
            "partial",
        );

        migrate(&root.0, LEGACY_IDENTIFIER, NEW, 1).unwrap();

        assert!(!root.0.join(NEW).join("junk").exists());
        assert_eq!(
            fs::read_to_string(local_storage(&root.0, NEW)).unwrap(),
            "profiles"
        );
    }

    #[test]
    fn does_nothing_for_a_dev_build() {
        let root = TempRoot::new("same");
        write(&local_storage(&root.0, LEGACY_IDENTIFIER), "dev");
        assert_eq!(
            migrate(&root.0, LEGACY_IDENTIFIER, LEGACY_IDENTIFIER, 1).unwrap(),
            Outcome::SameIdentifier
        );
        assert!(!root.0.join(LEGACY_IDENTIFIER).join(MARKER).exists());
    }
}
