//! Fase A2 of the in-app updater: a stateless check against GitHub's own
//! "latest release" endpoint, plus the one probe that decides whether this
//! install is even allowed to apply an update on its own later (Fase B).
//!
//! Rust does the network call and the origin probe; the JS side
//! (`appUpdate.ts`) owns every stateful decision — whether 24h have passed,
//! which version was already dismissed, what `updateMode` the user picked.
//! That split is deliberate, not incidental: it keeps the scheduling logic a
//! pure function the unit tier can test with a fake clock, with nothing here
//! needing to persist anything between calls.
//!
//! The origin probe (`app_install_source`) is a single command rather than
//! JS reading `APPIMAGE`/`APPDIR` itself and asking Rust something else,
//! because the three signals that matter — those two env vars,
//! `current_exe()`, and a real filesystem write-probe on macOS — all live on
//! this side of the IPC boundary, and splitting the gate across two round
//! trips would just be two chances for the answer to go stale between them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const GITHUB_LATEST_RELEASE_URL: &str = "https://api.github.com/repos/anywh-sh/anywh/releases/latest";
/// Escape hatch for the e2e tier (`update.spec.js`): no test build points
/// this at the real GitHub API, both because it has no network in CI and
/// because a real "latest release" would make the test's pass/fail depend
/// on what this repo happens to have shipped most recently.
const UPDATE_ENDPOINT_OVERRIDE_ENV: &str = "ANYWH_UPDATE_ENDPOINT";
/// Second e2e-only escape hatch (`updateDownload.spec.js`), gated by the
/// `e2e` Cargo feature so it can never exist in a real build: the e2e binary
/// is a plain `--no-bundle` debug build, not run from inside an AppImage or
/// `.app`, so `decide_origin` below would honestly (and correctly, for a
/// real dev build) answer `updatable: false` — which would make
/// `normalizeUpdateMode` silently downgrade `auto-download` back to
/// `notify` and defeat the entire point of that test, exercising the real
/// `tauri-plugin-updater` download+signature-verify path. Forcing the
/// answer here is the same kind of origin-probe override
/// `UPDATE_ENDPOINT_OVERRIDE_ENV` already is for the release check above.
#[cfg(feature = "e2e")]
const E2E_FORCE_UPDATABLE_ENV: &str = "ANYWH_E2E_FORCE_UPDATABLE";

// ---------------------------------------------------------------------------
// Origin probe
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Os {
    Linux,
    Macos,
    Windows,
    Other,
}

fn detect_os() -> Os {
    match std::env::consts::OS {
        "linux" => Os::Linux,
        "macos" => Os::Macos,
        "windows" => Os::Windows,
        _ => Os::Other,
    }
}

/// Every filesystem/env fact `decide_origin` needs, gathered once so the
/// decision itself can be a pure function a test can drive without ever
/// touching a real process env or a real disk.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OriginFacts {
    os: Os,
    appimage_env_set: bool,
    /// Only meaningful when `appimage_env_set` is false — an extracted
    /// AppDir's `AppRun` sets `APPDIR` alone, but a mounted AppImage sets
    /// both, and the mounted case must win the `appimage` branch below.
    appdir_env_set: bool,
    exec_path: PathBuf,
    exec_under_usr: bool,
    exec_inside_app_bundle: bool,
    /// Whether the directory *containing* the `.app` bundle (e.g.
    /// `/Applications`, not `Contents/MacOS`) accepted a throwaway write —
    /// the only portable way to answer "can this install replace itself"
    /// without parsing ACLs. Meaningful only when `exec_inside_app_bundle`.
    app_bundle_parent_writable: bool,
    exec_under_local_appdata: bool,
}

/// Walks from `path` up to the first ancestor whose file name ends in
/// `.app` — the bundle root, however many levels below it (`current_exe()`
/// for anywh at `Contents/MacOS/anywh` is three) `path` started at.
fn find_app_bundle_root(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(p) = current {
        if p.extension().is_some_and(|ext| ext == "app") {
            return Some(p.to_path_buf());
        }
        current = p.parent();
    }
    None
}

/// A throwaway file inside `dir` is the only check that isn't fooled by
/// setuid, ACLs, or a read-only filesystem masquerading as a writable one —
/// this is the exact question "can install.sh's rename land here" asks.
fn is_dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".anywh-write-probe-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn gather_origin_facts() -> OriginFacts {
    let os = detect_os();
    let appimage_env_set = std::env::var_os("APPIMAGE").is_some();
    let appdir_env_set = !appimage_env_set && std::env::var_os("APPDIR").is_some();
    let exec_path = std::env::current_exe().unwrap_or_default();

    let exec_under_usr = os == Os::Linux && (exec_path.starts_with("/usr/bin") || exec_path.starts_with("/usr/lib"));

    let bundle_root = if os == Os::Macos { find_app_bundle_root(&exec_path) } else { None };
    let exec_inside_app_bundle = bundle_root.is_some();
    let app_bundle_parent_writable = bundle_root.as_deref().and_then(Path::parent).is_some_and(is_dir_writable);

    let exec_under_local_appdata = os == Os::Windows
        && std::env::var_os("LOCALAPPDATA").is_some_and(|appdata| exec_path.starts_with(PathBuf::from(appdata)));

    OriginFacts {
        os,
        appimage_env_set,
        appdir_env_set,
        exec_path,
        exec_under_usr,
        exec_inside_app_bundle,
        app_bundle_parent_writable,
        exec_under_local_appdata,
    }
}

/// The decision table Fase A1 of the updater plan settled on: absence of a
/// signal never means "updatable", and a mounted AppImage always wins over
/// an extracted AppDir when (implausibly) both env vars are somehow set.
fn decide_origin(facts: &OriginFacts) -> (&'static str, bool) {
    if facts.appimage_env_set {
        return ("appimage", true);
    }
    if facts.appdir_env_set {
        return ("appdir", false);
    }
    match facts.os {
        Os::Linux if facts.exec_under_usr => ("system-package", false),
        Os::Macos if facts.exec_inside_app_bundle => ("app-bundle", facts.app_bundle_parent_writable),
        Os::Windows if facts.exec_under_local_appdata => ("nsis", true),
        _ => ("unknown", false),
    }
}

/// The marker `install.sh` writes at `<install dir>/app/install-source.json`
/// — see that script's own comment for why a missing or malformed one is
/// just absence, not an error.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallSourceMarker {
    pub version: u32,
    pub method: String,
    pub channel: String,
    pub path: String,
    pub installed_version: String,
    pub installed_at: String,
}

fn read_install_marker_from(install_dir: &Path) -> Option<InstallSourceMarker> {
    let content = std::fs::read_to_string(install_dir.join("app").join("install-source.json")).ok()?;
    serde_json::from_str(&content).ok()
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallOrigin {
    /// "appimage" | "appdir" | "system-package" | "app-bundle" | "nsis" | "unknown"
    pub channel: String,
    pub updatable: bool,
    pub exec_path: String,
    /// The install.sh marker, when one exists — descriptive only. The
    /// `channel`/`updatable` verdict above never depends on it, since the
    /// large majority of installs today predate Fase A1 and have none.
    pub marker: Option<InstallSourceMarker>,
}

#[tauri::command]
pub fn app_install_source() -> InstallOrigin {
    #[cfg(feature = "e2e")]
    if std::env::var_os(E2E_FORCE_UPDATABLE_ENV).is_some() {
        return InstallOrigin {
            channel: "e2e".to_string(),
            updatable: true,
            exec_path: std::env::current_exe().unwrap_or_default().to_string_lossy().to_string(),
            marker: None,
        };
    }

    let facts = gather_origin_facts();
    let (channel, updatable) = decide_origin(&facts);
    InstallOrigin {
        channel: channel.to_string(),
        updatable,
        exec_path: facts.exec_path.to_string_lossy().to_string(),
        marker: read_install_marker_from(&crate::relay_setup::default_install_dir()),
    }
}

// ---------------------------------------------------------------------------
// Release check
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
}

/// `NotModified` costs nothing against GitHub's anonymous 60/h rate limit —
/// that's the entire point of round-tripping the `ETag` in `etag`/out in
/// `Available`. `RateLimited` carries when it's safe to try again instead of
/// a bare error, so the JS scheduler can back off instead of hammering a
/// 403 every launch.
// `rename_all` on an enum only renames the *variants* ("Available" ->
// "available"); it does not reach into a struct variant's own fields
// without `rename_all_fields` alongside it. Missing that left the wire
// shape as `tag_name`/`html_url` while appUpdate.ts's `LatestReleaseCheck`
// type (and every caller of it) has always expected `tagName`/`htmlUrl` —
// a real bug, caught only by the e2e tier driving an actual "Check now"
// click end to end (client/tests/e2e/update.spec.js): every other tier
// injects an already-camelCase fake in place of this struct and never
// serializes it for real.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum LatestReleaseCheck {
    NotModified,
    Available { tag_name: String, html_url: String, etag: Option<String> },
    RateLimited { retry_after_epoch_ms: Option<i64> },
}

#[tauri::command]
pub async fn app_check_latest_release(app: tauri::AppHandle, etag: Option<String>) -> Result<LatestReleaseCheck, String> {
    let endpoint = std::env::var(UPDATE_ENDPOINT_OVERRIDE_ENV).unwrap_or_else(|_| GITHUB_LATEST_RELEASE_URL.to_string());

    // `app.package_info().version` reads tauri.conf.json's version, not
    // Cargo.toml's frozen 0.1.0 (see appVersion.test.ts for why those two
    // deliberately disagree) — this is the same number APP_VERSION carries
    // on the JS side.
    let version = tauri::Manager::package_info(&app).version.to_string();
    let client = reqwest::Client::builder()
        .user_agent(format!("anywh/{version}"))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client.get(&endpoint);
    if let Some(tag) = &etag {
        request = request.header("If-None-Match", tag);
    }

    let response = request.send().await.map_err(|e| e.to_string())?;

    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(LatestReleaseCheck::NotModified);
    }

    if response.status() == reqwest::StatusCode::FORBIDDEN {
        let remaining: Option<u32> = header_as(&response, "x-ratelimit-remaining");
        if remaining == Some(0) {
            let reset_epoch_secs: Option<i64> = header_as(&response, "x-ratelimit-reset");
            return Ok(LatestReleaseCheck::RateLimited { retry_after_epoch_ms: reset_epoch_secs.map(|s| s * 1000) });
        }
        return Err(format!("GitHub returned 403: {}", response.text().await.unwrap_or_default()));
    }

    if !response.status().is_success() {
        return Err(format!("GitHub returned {}", response.status()));
    }

    let new_etag = response.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_string);
    let release: GithubRelease = response.json().await.map_err(|e| e.to_string())?;
    Ok(LatestReleaseCheck::Available { tag_name: release.tag_name, html_url: release.html_url, etag: new_etag })
}

fn header_as<T: std::str::FromStr>(response: &reqwest::Response, name: &str) -> Option<T> {
    response.headers().get(name)?.to_str().ok()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(os: Os) -> OriginFacts {
        OriginFacts {
            os,
            appimage_env_set: false,
            appdir_env_set: false,
            exec_path: PathBuf::from("/nowhere"),
            exec_under_usr: false,
            exec_inside_app_bundle: false,
            app_bundle_parent_writable: false,
            exec_under_local_appdata: false,
        }
    }

    #[test]
    fn appimage_env_wins_regardless_of_os() {
        let f = OriginFacts { appimage_env_set: true, appdir_env_set: true, ..facts(Os::Linux) };
        assert_eq!(decide_origin(&f), ("appimage", true));
    }

    #[test]
    fn appdir_alone_is_not_updatable() {
        let f = OriginFacts { appdir_env_set: true, ..facts(Os::Linux) };
        assert_eq!(decide_origin(&f), ("appdir", false));
    }

    #[test]
    fn linux_under_usr_is_a_system_package() {
        let f = OriginFacts { exec_under_usr: true, ..facts(Os::Linux) };
        assert_eq!(decide_origin(&f), ("system-package", false));
    }

    #[test]
    fn linux_with_no_signal_is_unknown() {
        assert_eq!(decide_origin(&facts(Os::Linux)), ("unknown", false));
    }

    #[test]
    fn macos_bundle_updatable_only_if_parent_writable() {
        let writable = OriginFacts { exec_inside_app_bundle: true, app_bundle_parent_writable: true, ..facts(Os::Macos) };
        assert_eq!(decide_origin(&writable), ("app-bundle", true));

        let readonly = OriginFacts { exec_inside_app_bundle: true, app_bundle_parent_writable: false, ..facts(Os::Macos) };
        assert_eq!(decide_origin(&readonly), ("app-bundle", false));
    }

    #[test]
    fn macos_outside_any_bundle_is_unknown() {
        assert_eq!(decide_origin(&facts(Os::Macos)), ("unknown", false));
    }

    #[test]
    fn windows_under_local_appdata_is_nsis() {
        let f = OriginFacts { exec_under_local_appdata: true, ..facts(Os::Windows) };
        assert_eq!(decide_origin(&f), ("nsis", true));
    }

    #[test]
    fn windows_elsewhere_is_unknown() {
        assert_eq!(decide_origin(&facts(Os::Windows)), ("unknown", false));
    }

    #[test]
    fn finds_the_bundle_root_several_levels_above_the_executable() {
        let exec = Path::new("/Applications/anywh.app/Contents/MacOS/anywh");
        assert_eq!(find_app_bundle_root(exec), Some(PathBuf::from("/Applications/anywh.app")));
    }

    #[test]
    fn finds_no_bundle_root_when_there_is_none() {
        assert_eq!(find_app_bundle_root(Path::new("/usr/bin/anywh")), None);
    }

    fn fixture_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("anywh-updater-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_a_well_formed_marker() {
        let root = fixture_dir("marker-ok");
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(
            root.join("app/install-source.json"),
            r#"{"version":1,"method":"install.sh","channel":"appimage","path":"/x/anywh.AppImage","installedVersion":"0.1.8","installedAt":"2026-09-16T12:00:00Z"}"#,
        )
        .unwrap();
        let marker = read_install_marker_from(&root).expect("marker should parse");
        assert_eq!(marker.channel, "appimage");
        assert_eq!(marker.installed_version, "0.1.8");
    }

    #[test]
    fn a_missing_marker_is_none() {
        let root = fixture_dir("marker-missing");
        assert_eq!(read_install_marker_from(&root), None);
    }

    #[test]
    fn a_malformed_marker_is_none_not_an_error() {
        let root = fixture_dir("marker-malformed");
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("app/install-source.json"), "{ not json").unwrap();
        assert_eq!(read_install_marker_from(&root), None);
    }
}
