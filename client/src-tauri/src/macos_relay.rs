//! The relay the Apple Silicon app ships inside itself.
//!
//! The release build bundles a signed relay tree (the SEA binary, node-pty,
//! tmux, `infra/`) as the `relay/` resource. It never runs from the bundle:
//! an app opened from a disk image or Downloads runs from a random read-only
//! path (App Translocation), and an app moved or deleted would leave launchd
//! respawning a binary that is gone. So the tree is copied to
//! `~/Library/Application Support/<identifier>/relay/`, and each local
//! profile runs from there as two launchd jobs whose plists `add-profile.sh`
//! writes to `<same dir>/launchd/`.
//!
//! Those plists are outside `~/Library/LaunchAgents` on purpose: launchd
//! knows them only until logout, so nothing starts at login and macOS adds
//! no login item. Opening the app is what starts them ([`start_profiles`]),
//! and once started they outlive the app until logout.
//!
//! An app update ships a new tree. [`sync_tree`] swaps it in with two
//! renames; the relay and agent host that were running notice the new
//! `package.json` on their own (the release watch) and restart when idle,
//! and launchd's `KeepAlive` brings them back on the new binary.
//!
//! A build without the resource (dev, Intel) has no bundled relay, and
//! everything here is a no-op there.
//!
//! Compiled on every desktop Unix so its tests run in CI (Linux); only the
//! macOS app calls it.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Manager;

/// The bundled tree, when this build has one.
pub fn bundled_tree(app: &tauri::AppHandle) -> Option<PathBuf> {
    let tree = app.path().resource_dir().ok()?.join("relay");
    tree.join("anywh-relay").is_file().then_some(tree)
}

/// `~/Library/Application Support/<identifier>`: one per build identifier,
/// so a dev build and the official one keep their own trees and jobs.
pub fn support_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

pub fn launchd_dir(support: &Path) -> PathBuf {
    support.join("launchd")
}

/// Copies the bundled tree over the running copy when the two differ
/// (their `package.json`, which carries the release version). Next to it
/// first, then two renames, so a running relay never sees a half-written
/// tree. Returns the running copy.
pub fn sync_tree(bundled: &Path, support: &Path) -> io::Result<PathBuf> {
    // The app's opening and a profile being created can both get here at
    // once; two copies into the same `relay.new` would trip over each other.
    static SYNC: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one_at_a_time = SYNC.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let current = support.join("relay");
    let wanted = std::fs::read(bundled.join("package.json"))?;
    if std::fs::read(current.join("package.json")).ok().as_deref() == Some(wanted.as_slice()) {
        return Ok(current);
    }
    std::fs::create_dir_all(support)?;
    let staged = support.join("relay.new");
    let old = support.join("relay.old");
    remove_dir_if_present(&staged)?;
    remove_dir_if_present(&old)?;
    copy_tree(bundled, &staged)?;
    // An app opened from a download is quarantined, and so are the files a
    // copy of its bundle would carry along; launchd starting a quarantined
    // binary outside the app would ask Gatekeeper again, with no app in
    // front of the user. The bundle already passed it as part of the app.
    let _ = Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine"]).arg(&staged).status();
    if current.exists() {
        std::fs::rename(&current, &old)?;
    }
    std::fs::rename(&staged, &current)?;
    remove_dir_if_present(&old)?;
    Ok(current)
}

fn remove_dir_if_present(path: &Path) -> io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// `std::fs::copy` keeps the mode bits (the executables stay executable);
/// symlinks are recreated as symlinks.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_symlink() {
            std::os::unix::fs::symlink(std::fs::read_link(entry.path())?, &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

extern "C" {
    fn getuid() -> u32;
}

/// `gui/<uid>`: the logged-in user's launchd session.
pub fn gui_domain() -> String {
    // SAFETY: getuid takes no arguments, cannot fail and touches no memory.
    format!("gui/{}", unsafe { getuid() })
}

/// The plists of the local profiles, sorted (`sh.anywh.agent-host.*` before
/// `sh.anywh.relay.*`, as `add-profile.sh` starts them).
pub fn profile_plists(launchd: &Path) -> Vec<PathBuf> {
    let mut plists: Vec<PathBuf> = std::fs::read_dir(launchd)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "plist"))
                .collect()
        })
        .unwrap_or_default();
    plists.sort();
    plists
}

/// Starts every local profile's jobs that launchd does not have loaded: after
/// a login, none are. One already loaded is left alone, so opening the app
/// never restarts a relay in the middle of a turn. With no local profile
/// there are no plists, and nothing runs.
pub fn start_profiles(launchd: &Path) {
    let domain = gui_domain();
    for plist in profile_plists(launchd) {
        let Some(label) = plist.file_stem().and_then(|s| s.to_str()) else { continue };
        let loaded = Command::new("/bin/launchctl").args(["print", &format!("{domain}/{label}")]).output().is_ok_and(|out| out.status.success());
        if loaded {
            continue;
        }
        match Command::new("/bin/launchctl").arg("bootstrap").arg(&domain).arg(&plist).output() {
            Ok(out) if out.status.success() => eprintln!("[macos-relay] started {label}"),
            Ok(out) => eprintln!("[macos-relay] couldn't start {label}: {}", String::from_utf8_lossy(&out.stderr).trim()),
            Err(error) => eprintln!("[macos-relay] couldn't run launchctl for {label}: {error}"),
        }
    }
}

/// What the app does when it opens, off the UI thread: bring the running
/// copy up to the bundled tree, then start the local profiles.
pub fn on_app_open(app: &tauri::AppHandle) {
    let (Some(bundled), Some(support)) = (bundled_tree(app), support_dir(app)) else { return };
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = sync_tree(&bundled, &support) {
            // Still start what is there: an older relay beats none, and the
            // next launch tries the copy again.
            eprintln!("[macos-relay] couldn't update the relay tree: {error}");
        }
        start_profiles(&launchd_dir(&support));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!("anywh-macos-relay-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tree(dir: &Path, version: &str) {
        std::fs::create_dir_all(dir.join("infra/systemd")).unwrap();
        std::fs::write(dir.join("package.json"), format!("{{\"version\":\"{version}\"}}")).unwrap();
        std::fs::write(dir.join("anywh-relay"), version).unwrap();
        std::fs::write(dir.join("infra/systemd/add-profile.sh"), "").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join("anywh-relay"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn the_bundled_tree_replaces_a_different_copy_and_keeps_executables_executable() {
        let root = TempDir::new();
        let (bundled, support) = (root.path().join("bundle"), root.path().join("support"));
        tree(&bundled, "1.0.0");
        let current = sync_tree(&bundled, &support).unwrap();
        assert_eq!(std::fs::read_to_string(current.join("anywh-relay")).unwrap(), "1.0.0");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(current.join("anywh-relay")).unwrap().permissions().mode() & 0o111, 0o111);

        // An app update: a new tree, swapped in whole; nothing left beside it.
        std::fs::remove_dir_all(&bundled).unwrap();
        tree(&bundled, "1.1.0");
        sync_tree(&bundled, &support).unwrap();
        assert_eq!(std::fs::read_to_string(current.join("anywh-relay")).unwrap(), "1.1.0");
        let mut left: Vec<String> = std::fs::read_dir(&support).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, ["relay"]);
    }

    #[test]
    fn the_same_tree_is_not_copied_again() {
        let root = TempDir::new();
        let (bundled, support) = (root.path().join("bundle"), root.path().join("support"));
        tree(&bundled, "1.0.0");
        let current = sync_tree(&bundled, &support).unwrap();
        // A file the copy would overwrite stays as the running copy has it.
        std::fs::write(current.join("anywh-relay"), "running").unwrap();
        sync_tree(&bundled, &support).unwrap();
        assert_eq!(std::fs::read_to_string(current.join("anywh-relay")).unwrap(), "running");
    }

    #[test]
    fn only_plists_count_as_profiles_host_first() {
        let root = TempDir::new();
        for name in ["sh.anywh.relay.work.plist", "sh.anywh.agent-host.work.plist", "sh.anywh.relay.work.plist.tmp.42"] {
            std::fs::write(root.path().join(name), "").unwrap();
        }
        let names: Vec<String> = profile_plists(root.path()).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["sh.anywh.agent-host.work.plist", "sh.anywh.relay.work.plist"]);
        assert!(profile_plists(&root.path().join("missing")).is_empty());
    }
}
