//! Installs the relay on *this* machine from inside the app.
//!
//! Runs the very same `install-relay.sh` a terminal user would — embedded in the
//! binary at build time, written to the app's data dir, executed with
//! `--porcelain` and the profile flags — and lets the JS side watch it.
//! Nothing here reimplements a step of the install: the script is the one
//! implementation, and this module is its remote control.
//!
//! Three deliberate departures from `tailnet_sidecar.rs`, the other child
//! process this app spawns:
//!
//! - **The child writes to a file, not a pipe.** A pipe nobody drains
//!   blocks the writer once its 64 KiB fill up, and `curl`/`tar`/`systemctl`
//!   are far chattier than the sidecar. If the app died mid-install the
//!   reader would be gone and the installer would freeze inside `tar` — a
//!   half-extracted tree that is worse than a clean death. So stdout and
//!   stderr go straight to `<runId>.log` and this side tails it by polling.
//!   The same file is what a later launch reads to show the log from the
//!   start, with no extra mechanism.
//! - **Not adopted into the Windows job object, not killed on exit.** A
//!   sidecar without an app is garbage; an install without an app is an
//!   install. The child is meant to outlive us, and the next launch
//!   re-attaches to it through `state.json` and `/proc`.
//! - **`relay_setup_status` is the source of truth, the events are not.**
//!   `app.emit` is fire-and-forget and lost without a mounted listener. The
//!   UI hydrates the whole log on mount, then subscribes; every event carries
//!   a monotonic `seq`, and a gap tells it to hydrate again.
//!
//! Linux and macOS can start a run — the embedded script differs (systemd
//! via `install-relay.sh`; on a Mac app that ships its own relay, that
//! relay's `add-profile.sh` through `BUNDLED_PROFILE_SCRIPT`; Homebrew via
//! `MACOS_INSTALL_SCRIPT` otherwise), the porcelain protocol and everything
//! downstream of it does not. Everywhere else, the
//! probe, the prerequisites and the address suggestion still answer, so the
//! first-run screen can explain *why* not.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

/// The installer, byte for byte as this build shipped it. Embedded rather
/// than downloaded or read from `resources/`: the tarball's integrity is the
/// script's own job (checksums against the release's `SHA256SUMS`), so the
/// one thing left uncovered would be the script itself — bytes in the
/// binary sit under the platform's code signature, while a file next to it
/// is writable by anything running as the user, and we execute it. It also
/// ties the versions together: a run passes `--version v<app version>`, so
/// the app never provisions a relay whose control API it doesn't know.
pub const INSTALL_SCRIPT: &str = include_str!("../../../install-relay.sh");

/// The Homebrew orchestration this app runs on macOS instead — install-relay.sh
/// downloads a tree there too, but never a service (see its own "No
/// launchd here" comment), so there is nothing in it for `relay_setup_start`
/// to drive on that platform.
pub const MACOS_INSTALL_SCRIPT: &str = include_str!("../../../infra/homebrew/app-install.sh");

/// On a Mac app that ships its own relay (`macos_relay.rs`) there is nothing
/// to install: the tree is copied out of the bundle, and creating the profile
/// is that tree's own `add-profile.sh`, which writes and starts its launchd
/// jobs. This wraps it in the installers' porcelain (a step, then `done ok`)
/// so the run reads like any other. Its first argument is the script.
pub const BUNDLED_PROFILE_SCRIPT: &str = r#"#!/usr/bin/env bash
set -uo pipefail
add_profile="$1"
shift
echo "ANYWH step profile"
bash "$add_profile" "$@"
status=$?
if [ "$status" -ne 0 ]; then
  echo "ANYWH fail profile profile_failed couldn't create the profile; see the lines above"
  exit "$status"
fi
echo "ANYWH done profile"
echo "ANYWH done ok service=launchd"
"#;

/// Dev and e2e escape hatch: a path to run instead of the embedded script.
const INSTALL_SCRIPT_OVERRIDE_ENV: &str = "ANYWH_INSTALL_SCRIPT";

const LOG_EVENT: &str = "relay-setup-log";
const DONE_EVENT: &str = "relay-setup-done";

const NODE_MIN_MAJOR: u32 = 20;
const NODE_MIN_MINOR: u32 = 12;

// ---------------------------------------------------------------------------
// Porcelain
// ---------------------------------------------------------------------------

/// One `ANYWH ...` line from `install-relay.sh --porcelain` (or from
/// `add-profile.sh --porcelain`, which the installer passes through).
/// Anything that isn't one of these four shapes is prose for the human log.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PorcelainEvent {
    Step { step: String },
    Done { step: String, fields: BTreeMap<String, String> },
    Fail { step: String, code: String, message: String },
    Profile { fields: BTreeMap<String, String> },
}

fn parse_fields(rest: &str) -> BTreeMap<String, String> {
    rest.split_whitespace()
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

pub fn parse_porcelain_line(line: &str) -> Option<PorcelainEvent> {
    let rest = line.trim().strip_prefix("ANYWH ")?;
    let (verb, rest) = rest.split_once(' ').unwrap_or((rest, ""));
    match verb {
        "step" => {
            let step = rest.split_whitespace().next()?;
            Some(PorcelainEvent::Step { step: step.to_string() })
        }
        "done" => {
            let (step, fields) = rest.split_once(' ').unwrap_or((rest, ""));
            if step.is_empty() {
                return None;
            }
            Some(PorcelainEvent::Done { step: step.to_string(), fields: parse_fields(fields) })
        }
        "fail" => {
            let mut parts = rest.splitn(3, ' ');
            let step = parts.next()?.to_string();
            let code = parts.next()?.to_string();
            let message = parts.next().unwrap_or("").to_string();
            Some(PorcelainEvent::Fail { step, code, message })
        }
        "profile" => Some(PorcelainEvent::Profile { fields: parse_fields(rest) }),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Probe — std::fs only, no network, no processes
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeProfile {
    pub id: String,
    /// From `profiles.json`; `None` for an `.env` the registry doesn't know
    /// (see `Probe::orphan_default`).
    pub label: Option<String>,
    pub port: Option<u16>,
    pub host: Option<String>,
    pub home_override: Option<String>,
    /// Listed in `profiles.json` — what makes it a real profile rather than
    /// a stray `.env`.
    pub registered: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub platform: &'static str,
    /// The in-app install can run here: Linux or macOS, and — on Linux —
    /// not inside a Flatpak or Snap sandbox (neither sees the host's
    /// `systemd --user`, so the install would die at its last step).
    pub supported: bool,
    pub containerized: Option<&'static str>,
    pub install_dir: String,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub unit_installed: bool,
    pub env_dir: String,
    pub profiles: Vec<ProbeProfile>,
    /// A `default.env` that `profiles.json` doesn't list — what a stray
    /// `npm run dev` of the relay leaves behind (`ensureSelfRegistered`).
    /// Not a profile; shown so it can be deleted, never adopted.
    pub orphan_default: bool,
    pub previous_run: Option<RunStatus>,
}

fn read_env_file(path: &Path) -> BTreeMap<String, String> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[derive(Deserialize)]
struct ProfilesJson {
    #[serde(default)]
    profiles: Vec<ProfilesJsonEntry>,
}

#[derive(Deserialize)]
struct ProfilesJsonEntry {
    id: String,
    label: Option<String>,
}

fn read_profiles_json(env_dir: &Path) -> Vec<ProfilesJsonEntry> {
    let Some(parent) = env_dir.parent() else {
        return Vec::new();
    };
    let Ok(content) = std::fs::read_to_string(parent.join("profiles.json")) else {
        return Vec::new();
    };
    serde_json::from_str::<ProfilesJson>(&content).map(|json| json.profiles).unwrap_or_default()
}

fn installed_version(install_dir: &Path) -> Option<String> {
    #[derive(Deserialize)]
    struct PackageJson {
        version: Option<String>,
    }
    let content = std::fs::read_to_string(install_dir.join("relay").join("package.json")).ok()?;
    serde_json::from_str::<PackageJson>(&content).ok()?.version
}

/// Everything the probe learns from disk, with the directories passed in so
/// a test can point it at a fixture. The command wraps this with the real
/// paths and the platform facts.
pub fn probe_dirs(install_dir: &Path, env_dir: &Path, systemd_user_dir: &Path) -> (bool, Option<String>, bool, Vec<ProbeProfile>, bool) {
    let installed = install_dir.join("relay").join("dist").join("server.js").is_file();
    let version = installed_version(install_dir);
    let unit_installed = systemd_user_dir.join("anywh-relay@.service").is_file();

    let registry = read_profiles_json(env_dir);
    let mut profiles: Vec<ProbeProfile> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(env_dir) {
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter_map(|name| name.strip_suffix(".env").map(str::to_string))
            .collect();
        names.sort();
        for id in names {
            let env = read_env_file(&env_dir.join(format!("{id}.env")));
            let entry = registry.iter().find(|p| p.id == id);
            profiles.push(ProbeProfile {
                label: entry.and_then(|p| p.label.clone()),
                registered: entry.is_some(),
                port: env.get("RELAY_PORT").and_then(|v| v.parse().ok()),
                host: env.get("RELAY_HOST").cloned(),
                home_override: env.get("RELAY_HOME_OVERRIDE").cloned(),
                id,
            });
        }
    }
    let orphan_default = profiles.iter().any(|p| p.id == "default" && !p.registered);
    (installed, version, unit_installed, profiles, orphan_default)
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Same defaults `install-relay.sh` and `infra/lib.sh` use, same env overrides —
/// so what the probe reports is what a run would touch. `pub(crate)` since
/// `updater.rs` reads the same directory for `install.sh`'s marker file —
/// one machine, one anywh directory, so there is exactly one place that gets
/// to compute this path.
pub(crate) fn default_install_dir() -> PathBuf {
    std::env::var_os("ANYWH_INSTALL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".local/share/anywh"))
}

fn default_env_dir() -> PathBuf {
    std::env::var_os("ANYWH_ENV_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config/anywh/env"))
}

fn containerized() -> Option<&'static str> {
    if Path::new("/.flatpak-info").exists() {
        return Some("flatpak");
    }
    if std::env::var_os("SNAP").is_some() {
        return Some("snap");
    }
    None
}

const PLATFORM: &str = if cfg!(target_os = "linux") {
    "linux"
} else if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(windows) {
    "windows"
} else {
    "other"
};

#[tauri::command]
pub async fn relay_setup_probe(app: tauri::AppHandle, state: tauri::State<'_, RelaySetup>) -> Result<Probe, String> {
    let install_dir = default_install_dir();
    let env_dir = default_env_dir();
    let systemd_user_dir = home_dir().join(".config/systemd/user");
    let (installed, installed_version, unit_installed, profiles, orphan_default) =
        probe_dirs(&install_dir, &env_dir, &systemd_user_dir);
    let containerized = containerized();
    let previous_run = status_inner(&app, &state).await?;
    Ok(Probe {
        platform: PLATFORM,
        supported: (PLATFORM == "linux" || PLATFORM == "macos") && containerized.is_none(),
        containerized,
        install_dir: install_dir.to_string_lossy().into_owned(),
        installed,
        installed_version,
        unit_installed,
        env_dir: env_dir.to_string_lossy().into_owned(),
        profiles,
        orphan_default,
        previous_run,
    })
}

// ---------------------------------------------------------------------------
// Prerequisites — processes, still no network
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Prerequisites {
    /// Absolute path, resolved through a login shell — this is what becomes
    /// `{{NODE_BIN}}` in the unit's `ExecStart`, so it is worth showing.
    pub node_path: Option<String>,
    pub node_version: Option<String>,
    pub node_ok: bool,
    /// Only meaningful on macOS, where the in-app install drives Homebrew
    /// instead of a preinstalled Node — the formula pulls its own via
    /// `depends_on "node"`, so `node_path`/`node_ok` above answer a
    /// question that platform doesn't ask.
    pub brew_path: Option<String>,
    /// This macOS app ships its own relay: nothing to install, no Homebrew.
    pub bundled_relay: bool,
    /// `systemctl --user` answers in this session.
    pub systemd_user: bool,
    pub xdg_runtime_dir: bool,
    /// `anywh-relay@<id>` instances currently active — an install must never
    /// swap the tree under a running relay.
    pub active_units: Vec<String>,
}

/// `major.minor >= 20.12`, the relay's `engines.node`.
pub fn node_version_ok(version: &str) -> bool {
    let mut parts = version.trim().trim_start_matches('v').split('.');
    let major: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    major > NODE_MIN_MAJOR || (major == NODE_MIN_MAJOR && minor >= NODE_MIN_MINOR)
}

/// Runs `command` through `bash -lc`: a GUI app doesn't inherit the PATH an
/// interactive shell builds (nvm, asdf, Homebrew on macOS all live in
/// profile files), so `node` and `brew` are routinely invisible
/// to a plain `Command`. Returns the last non-empty stdout line — a profile
/// that prints a banner must not turn into "the path to node".
async fn login_shell_line(command: &str, timeout: Duration) -> Option<String> {
    let output = tokio::time::timeout(
        timeout,
        tokio::process::Command::new("bash")
            .args(["-lc", command])
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().map(str::trim).filter(|l| !l.is_empty()).last().map(str::to_string)
}

async fn systemctl_user_ok() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("systemctl").args(["--user", "show-environment"]).output(),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .is_some_and(|output| output.status.success())
}

async fn active_relay_units() -> Vec<String> {
    if !cfg!(target_os = "linux") {
        return Vec::new();
    }
    let Ok(Ok(output)) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("systemctl")
            .args(["--user", "list-units", "anywh-relay@*", "--state=active", "--no-legend", "--plain"])
            .output(),
    )
    .await
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .filter(|unit| unit.starts_with("anywh-relay@"))
        .map(str::to_string)
        .collect()
}

/// The Homebrew relay's update and restart, as one shell line. Homebrew's
/// own bin directories go first on PATH: a login bash does not read the zsh
/// profile where most Macs set Homebrew up, and the app's own PATH has none.
///
/// It upgrades and restarts only when the tap's formula has a newer relay
/// than the one installed, and exits `BREW_NOTHING_NEWER` otherwise: the
/// tap follows stable releases only, and is bumped after one is published,
/// so an app can be ahead of it. Restarting a relay that `brew upgrade` left
/// as it was would only make the app wait for a version that never comes.
/// (The same steps, for a Mac the app reaches through the relay's terminal:
/// `upgradeCommand` in client/src/lib/relay/legacyRelayUpgrade.ts.)
const BREW_UPGRADE_COMMAND: &str = concat!(
    "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; ",
    "brew update >/dev/null && brew list --versions anywh-relay >/dev/null && ",
    "if brew outdated --quiet anywh-relay | grep -q anywh-relay; ",
    "then brew upgrade anywh-relay && brew services restart anywh-relay; ",
    "else exit 4; fi",
);

/// `BREW_UPGRADE_COMMAND`'s exit status when the formula has nothing newer.
const BREW_NOTHING_NEWER: i32 = 4;

/// On a Mac app that ships its own relay, the update of a Homebrew relay is
/// moving its profile to the app's relay, once: a Homebrew relay and the
/// app's own would otherwise be two ways to run (and update) a relay on the
/// same Mac, and the tap only moves with stable releases. Profiles are the
/// machine's (`~/.config/anywh/env`), so nothing is copied: the Homebrew
/// service is stopped, the app's `add-profile.sh` resumes the same
/// `default` profile (same port, host and keys) under the app's launchd
/// jobs, and only once that relay answers is the formula uninstalled. Any
/// failure before that puts the Homebrew service back as it was.
///
/// `$1` is the app's `add-profile.sh`, `$2` the launchd directory its jobs
/// go to. Homebrew's bin directories first on PATH, as in
/// `BREW_UPGRADE_COMMAND`. Its last `Error:` line is the reason shown.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const BREW_MIGRATE_SCRIPT: &str = r#"set -u
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
add_profile="$1"
export ANYWH_LAUNCHD_DIR="$2"
export ANYWH_RELAY_MANAGED_BY_APP=1
env_file="${ANYWH_ENV_DIR:-$HOME/.config/anywh/env}/default.env"
launchctl_bin="${LAUNCHCTL_BIN:-launchctl}"
tries="${ANYWH_RELAY_READY_TRIES:-150}"
value() { sed -n "s/^$1=//p" "$env_file" | tail -n 1; }
if ! brew list --versions anywh-relay >/dev/null 2>&1; then echo "Error: the Homebrew relay isn't installed" >&2; exit 1; fi
if [ ! -f "$env_file" ]; then echo "Error: no default profile at $env_file" >&2; exit 1; fi
host="$(value RELAY_HOST)"
port="$(value RELAY_PORT)"
put_back() {
  for label in sh.anywh.relay.default sh.anywh.agent-host.default; do
    "$launchctl_bin" bootout "gui/$(id -u)/$label" >/dev/null 2>&1
    rm -f "$ANYWH_LAUNCHD_DIR/$label.plist"
  done
  brew services start anywh-relay >/dev/null 2>&1
}
answers() { (exec 3<>"/dev/tcp/${host:-127.0.0.1}/$port") 2>/dev/null; }
if ! brew services stop anywh-relay; then echo "Error: couldn't stop the Homebrew relay" >&2; exit 1; fi
# Cut off from here on (the app quit, the run's time limit), Homebrew's
# relay comes back rather than leaving the Mac with none.
trap 'put_back; exit 1' TERM HUP INT
# The old relay drains its turns before letting go of the port; the new one
# must not take its answer for its own.
left="$tries"
while answers; do
  left=$((left - 1))
  if [ "$left" -le 0 ]; then put_back; echo "Error: the Homebrew relay didn't let go of port $port" >&2; exit 1; fi
  sleep 0.2
done
if ! bash "$add_profile" default --resume --mode prod; then
  put_back
  echo "Error: couldn't move the profile to the app's relay" >&2
  exit 1
fi
answered=0
while [ "$tries" -gt 0 ]; do
  if answers; then answered=1; break; fi
  tries=$((tries - 1))
  sleep 0.2
done
if [ "$answered" -ne 1 ]; then
  put_back
  echo "Error: the app's relay didn't answer on ${host:-127.0.0.1}:$port" >&2
  exit 1
fi
trap - TERM HUP INT
brew uninstall anywh-relay >/dev/null 2>&1 || echo "warning: couldn't uninstall the Homebrew relay; its service stays stopped" >&2
exit 0
"#;

/// Why a Homebrew run failed, short enough to show: its last `Error:` line
/// (Homebrew's own words for it, on stderr), else the last few lines of
/// stderr, else of stdout. Never stdout after stderr: Homebrew's progress
/// lines go to stdout and would push the reason out of the tail.
pub fn failure_tail(stdout: &str, stderr: &str) -> String {
    let lines = |text: &str| text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect::<Vec<_>>();
    let (err, out) = (lines(stderr), lines(stdout));
    let last_error = |lines: &[String]| lines.iter().rev().find(|line| line.starts_with("Error:")).cloned();
    if let Some(error) = last_error(&err).or_else(|| last_error(&out)) {
        return error;
    }
    let source = if err.is_empty() { out } else { err };
    let start = source.len().saturating_sub(3);
    source[start..].join(" ")
}

/// Upgrades the Homebrew relay on this Mac and restarts its service — the
/// one-button update for a relay from before self-update when it runs on
/// the same machine as the app. The relay's own terminal cannot do it here
/// (it needs tmux, which a stock Mac does not have), and the app is already
/// on that machine. The caller checks that no conversation has a turn in
/// flight first; `brew services restart` is the relay's graceful shutdown.
///
/// Fails with a `BrewUpgradeError`, whose `code` the app turns into the
/// person's own language; only `detail` (Homebrew's or the OS's own words)
/// is shown as it is.
#[tauri::command]
pub async fn relay_brew_upgrade(
    app: tauri::AppHandle,
    state: tauri::State<'_, RelaySetup>,
    relay_hostname: Option<String>,
) -> Result<(), BrewUpgradeError> {
    if !cfg!(target_os = "macos") {
        return Err(BrewUpgradeError::new("unsupported_platform"));
    }
    // A loopback address is no proof the relay runs here: an SSH tunnel to
    // another Mac looks the same. The relay names its machine in
    // `/host-info` (Node's `os.hostname()`, gethostname(3)), and so does
    // this side, the same way; when they differ, this Mac's Homebrew is the
    // wrong one to touch, and the app goes through the relay's terminal.
    if let Some(name) = relay_hostname.as_deref() {
        if !same_machine(name, &tauri_plugin_os::hostname()) {
            return Err(BrewUpgradeError::new("other_machine"));
        }
    }
    // One Homebrew run at a time: two upgrades, or an upgrade next to the
    // in-app install's `brew install`, would fight over Homebrew's locks and
    // the relay's service. Decided under the install's own lock, which
    // `relay_setup_start` checks the flag under too.
    let _running = {
        let _inner = state.0.lock().await;
        let installing = setup_dir(&app)
            .ok()
            .and_then(|dir| read_state(&dir))
            .is_some_and(|run| run.exit_code.is_none() && pid_is_installer(run.pid, &run.script_path));
        if installing {
            return Err(BrewUpgradeError::new("busy"));
        }
        BrewUpgradeRunning::claim().ok_or_else(|| BrewUpgradeError::new("busy"))?
    };
    // An app that ships its own relay moves the profile to it instead.
    #[cfg(target_os = "macos")]
    if let (Some(tree), Some(support)) = (crate::macos_relay::bundled_tree(&app), crate::macos_relay::support_dir(&app)) {
        return migrate_brew_relay(tree, support).await;
    }
    let output = run_in_own_group(&["-lc", BREW_UPGRADE_COMMAND], Duration::from_secs(600)).await?;
    brew_outcome(output.status.code(), &String::from_utf8_lossy(&output.stdout), &String::from_utf8_lossy(&output.stderr))
}

/// Moves the Homebrew relay's profile to the relay this app ships
/// (`BREW_MIGRATE_SCRIPT`), after bringing the app's running copy of it up
/// to date.
#[cfg(target_os = "macos")]
async fn migrate_brew_relay(tree: PathBuf, support: PathBuf) -> Result<(), BrewUpgradeError> {
    let relay = {
        let support = support.clone();
        tauri::async_runtime::spawn_blocking(move || crate::macos_relay::sync_tree(&tree, &support))
            .await
            .map_err(|e| BrewUpgradeError::with_detail("failed", e.to_string()))?
            .map_err(|e| BrewUpgradeError::with_detail("failed", format!("couldn't set up the relay that came with the app: {e}")))?
    };
    let add_profile = relay.join("infra/systemd/add-profile.sh");
    let launchd = crate::macos_relay::launchd_dir(&support);
    let (add_profile, launchd) = (add_profile.to_string_lossy(), launchd.to_string_lossy());
    let output = run_in_own_group(&["-lc", BREW_MIGRATE_SCRIPT, "brew-migrate", &add_profile, &launchd], Duration::from_secs(600)).await?;
    brew_outcome(output.status.code(), &String::from_utf8_lossy(&output.stdout), &String::from_utf8_lossy(&output.stderr))
}

/// Whether the relay's host name is this machine's. Case aside, the names
/// come from the same call on the same machine; an empty one (a relay that
/// sent none) proves nothing either way, and is taken as this machine.
fn same_machine(relay: &str, this: &str) -> bool {
    relay.is_empty() || relay.eq_ignore_ascii_case(this)
}

/// Set while the app runs a Homebrew upgrade of the relay.
static BREW_UPGRADE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Holds `BREW_UPGRADE_RUNNING` for one run, and lets it go however the run
/// ends.
struct BrewUpgradeRunning;

impl BrewUpgradeRunning {
    fn claim() -> Option<Self> {
        BREW_UPGRADE_RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| BrewUpgradeRunning)
    }
}

impl Drop for BrewUpgradeRunning {
    fn drop(&mut self) {
        BREW_UPGRADE_RUNNING.store(false, Ordering::SeqCst);
    }
}
/// Runs `bash` with `bash_args` (`-lc <line>`) in a process group of its own, and
/// Runs `script` through `bash -lc` in a process group of its own, and
/// stops the whole group if it runs past `limit`. Homebrew is a grandchild
/// of that shell (and forks more of its own): dropping the wait would leave
/// all of it running, and killing only the shell would orphan the rest.
async fn run_in_own_group(bash_args: &[&str], limit: Duration) -> Result<std::process::Output, BrewUpgradeError> {
    let mut command = tokio::process::Command::new("bash");
    command
        .args(bash_args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn().map_err(|error| BrewUpgradeError::with_detail("spawn_failed", error.to_string()))?;
    let group = child.id();
    match tokio::time::timeout(limit, child.wait_with_output()).await {
        Ok(output) => output.map_err(|error| BrewUpgradeError::with_detail("spawn_failed", error.to_string())),
        Err(_) => {
            // The shell itself went with the dropped wait (`kill_on_drop`);
            // this reaches everything it started. `--` as in
            // `relay_setup_cancel`.
            #[cfg(unix)]
            if let Some(pid) = group {
                let _ = std::process::Command::new("kill").args(["-TERM", "--", &format!("-{pid}")]).status();
            }
            #[cfg(not(unix))]
            let _ = group;
            Err(BrewUpgradeError::new("timeout"))
        }
    }
}

/// Why `relay_brew_upgrade` did not upgrade the relay. `code` is one of a
/// closed set the app maps to its dictionary: `unsupported_platform`,
/// `other_machine` (the relay names another machine than this one),
/// `busy` (Homebrew is already updating or installing the relay),
/// `nothing_newer` (the tap has no newer relay yet; nothing was restarted),
/// `timeout`, `spawn_failed`, `failed`.
#[derive(Debug, PartialEq, Serialize)]
pub struct BrewUpgradeError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl BrewUpgradeError {
    fn new(code: &'static str) -> Self {
        BrewUpgradeError { code, detail: None }
    }

    fn with_detail(code: &'static str, detail: String) -> Self {
        BrewUpgradeError { code, detail: (!detail.is_empty()).then_some(detail) }
    }
}

/// What a finished Homebrew run means, from its exit status and output.
fn brew_outcome(status: Option<i32>, stdout: &str, stderr: &str) -> Result<(), BrewUpgradeError> {
    match status {
        Some(0) => Ok(()),
        Some(BREW_NOTHING_NEWER) => Err(BrewUpgradeError::new("nothing_newer")),
        _ => Err(BrewUpgradeError::with_detail("failed", failure_tail(stdout, stderr))),
    }
}

#[tauri::command]
pub async fn relay_setup_prerequisites(app: tauri::AppHandle) -> Prerequisites {
    let short = Duration::from_secs(10);
    let node_path = login_shell_line("command -v node", short).await;
    let node_version = match &node_path {
        Some(_) => login_shell_line("node -p process.versions.node", short).await,
        None => None,
    };
    let node_ok = node_version.as_deref().is_some_and(node_version_ok);
    let brew_path = login_shell_line("command -v brew", short).await;

    Prerequisites {
        node_path,
        node_version,
        node_ok,
        brew_path,
        bundled_relay: bundled_relay(&app).is_some(),
        systemd_user: systemctl_user_ok().await,
        xdg_runtime_dir: std::env::var_os("XDG_RUNTIME_DIR").is_some(),
        active_units: active_relay_units().await,
    }
}

// ---------------------------------------------------------------------------
// Address suggestion
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum AddressKind {
    /// 100.64.0.0/10 — a tailnet address, the same from anywhere.
    Tailnet,
    /// RFC 1918 — reachable from this LAN.
    Lan,
    Public,
    /// Never recommended: a relay bound here works from this machine and is
    /// unreachable from every other device, with no symptom.
    Loopback,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddressCandidate {
    pub address: String,
    pub kind: AddressKind,
    pub interface: String,
    pub recommended: bool,
}

pub fn classify_ipv4(ip: Ipv4Addr) -> AddressKind {
    let [a, b, _, _] = ip.octets();
    match (a, b) {
        (127, _) => AddressKind::Loopback,
        (100, 64..=127) => AddressKind::Tailnet,
        (10, _) | (172, 16..=31) | (192, 168) => AddressKind::Lan,
        _ => AddressKind::Public,
    }
}

/// Container and VM bridges carry a private address no other device can
/// reach; counting them would make "exactly one LAN address" false on every
/// box with Docker. Same list `install-relay.sh --relay-host auto` skips.
pub fn is_virtual_interface(name: &str) -> bool {
    ["docker", "br-", "veth", "virbr", "lxdbr", "lxcbr", "cni", "flannel", "podman"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// Tailnet first, then LAN, then public; loopback last and never
/// recommended. Exactly one address is `recommended`: the first tailnet
/// one, else the LAN one if there is exactly one, else nothing — several
/// LAN addresses is a question for the human, not a guess.
pub fn suggest_addresses(interfaces: impl IntoIterator<Item = (String, Ipv4Addr)>) -> Vec<AddressCandidate> {
    let mut candidates: Vec<AddressCandidate> = interfaces
        .into_iter()
        .filter(|(name, _)| !is_virtual_interface(name))
        .map(|(interface, ip)| AddressCandidate {
            address: ip.to_string(),
            kind: classify_ipv4(ip),
            interface,
            recommended: false,
        })
        .collect();
    candidates.sort_by_key(|c| c.kind);
    let lan_count = candidates.iter().filter(|c| c.kind == AddressKind::Lan).count();
    let pick = candidates
        .iter()
        .position(|c| c.kind == AddressKind::Tailnet)
        .or_else(|| (lan_count == 1).then(|| candidates.iter().position(|c| c.kind == AddressKind::Lan)).flatten());
    if let Some(index) = pick {
        candidates[index].recommended = true;
    }
    candidates
}

#[tauri::command]
pub fn relay_setup_suggest_address() -> Result<Vec<AddressCandidate>, String> {
    let interfaces = if_addrs::get_if_addrs().map_err(|e| e.to_string())?;
    Ok(suggest_addresses(interfaces.into_iter().filter_map(|iface| match iface.ip() {
        std::net::IpAddr::V4(ip) => Some((iface.name, ip)),
        std::net::IpAddr::V6(_) => None,
    })))
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartParams {
    /// Optional on purpose: with only a label, `install-relay.sh` derives the id
    /// with the relay's own slug rule and reports it back on the
    /// `ANYWH profile id=` line — the client never re-implements that rule.
    pub profile_id: Option<String>,
    pub profile_label: Option<String>,
    pub relay_host: String,
    pub profile_home: Option<String>,
    /// `prod` (default) registers the systemd unit and enables the instance;
    /// `dev` touches no systemd at all — the only mode a developer's own
    /// machine, which already runs real profiles, should ever see.
    pub mode: Option<String>,
}

/// What is written to `state.json` before the spawn (with `pid: 0`) and
/// corrected right after, so a death between the two never loses the pid.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub run_id: String,
    pub pid: u32,
    pub log_path: String,
    pub script_path: String,
    pub started_at: u64,
    pub params: StartParams,
    #[serde(default)]
    pub cancelled: bool,
    /// Set by the tailer once the child is gone. Absent on a run the app
    /// died on — `RunStatus::alive` false with no exit code is "interrupted".
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub finished_at: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub seq: u64,
    pub line: String,
    pub event: Option<PorcelainEvent>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileResult {
    pub id: String,
    pub port: Option<u16>,
    pub host: Option<String>,
    pub mode: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FailureInfo {
    pub step: String,
    pub code: String,
    pub message: String,
}

/// The whole picture of one run — the source of truth the UI hydrates from.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus {
    pub run_id: String,
    pub pid: u32,
    pub alive: bool,
    pub cancelled: bool,
    pub exit_code: Option<i32>,
    pub started_at: u64,
    pub params: StartParams,
    pub lines: Vec<LogLine>,
    /// `ANYWH done ok` was seen.
    pub ok: bool,
    pub profile: Option<ProfileResult>,
    pub failure: Option<FailureInfo>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub run_id: String,
    pub seq: u64,
    pub line: String,
    pub event: Option<PorcelainEvent>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DoneEvent {
    pub run_id: String,
    pub exit_code: Option<i32>,
    pub ok: bool,
    pub profile: Option<ProfileResult>,
    pub failure: Option<FailureInfo>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub run_id: String,
    pub log_path: String,
    /// `false` when an already-running install was joined instead of a new
    /// one started.
    pub started: bool,
}

struct Inner {
    /// The run whose log a tailer task is currently following, if any.
    tailing: Option<String>,
}

/// One `tokio::sync::Mutex` held for the whole start-or-join: two
/// concurrent `rm -rf`/`tar` in the same directory is far worse than two
/// sidecars, so a second start while a run is alive returns the existing id.
pub struct RelaySetup(Mutex<Inner>);

impl Default for RelaySetup {
    fn default() -> Self {
        RelaySetup(Mutex::new(Inner { tailing: None }))
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn setup_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("relay-setup");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn state_path(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

fn read_state(dir: &Path) -> Option<RunState> {
    let content = std::fs::read_to_string(state_path(dir)).ok()?;
    serde_json::from_str(&content).ok()
}

/// Written to a sibling and renamed: a half-written `state.json` would read
/// as "no run", and the next launch would happily start a second install
/// next to the one still running.
fn write_state(dir: &Path, state: &RunState) -> Result<(), String> {
    let tmp = dir.join("state.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, state_path(dir)).map_err(|e| e.to_string())
}

/// Is `pid` still the installer? Reused pids alone are not enough — a
/// stale `state.json` pointing at whatever process inherited the number
/// would make a finished install look alive forever. The command line has
/// to still name a script this module could have started.
///
/// `install.sh` stays in the list next to `install-relay.sh` even though
/// this module no longer writes that name: a run started by an older build
/// is still running under it, and an app updated mid-install has to
/// recognize its own child rather than start a second one beside it.
pub fn pid_is_installer(pid: u32, script_path: &str) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
            return false;
        };
        let cmdline = String::from_utf8_lossy(&cmdline);
        return cmdline.contains(script_path) || cmdline.contains("install-relay.sh") || cmdline.contains("install.sh");
    }
    #[cfg(target_os = "macos")]
    {
        // No /proc here — `ps` is the closest equivalent, and `-o command=`
        // (no header) gives back the same argv join `/proc/<pid>/cmdline`
        // would, spaces and all, which is enough to recognize either script.
        let Ok(output) = std::process::Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output() else {
            return false;
        };
        if !output.status.success() {
            return false;
        }
        let cmdline = String::from_utf8_lossy(&output.stdout);
        return cmdline.contains(script_path)
            || cmdline.contains("install-relay.sh")
            || cmdline.contains("install.sh")
            || cmdline.contains("app-install.sh");
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = script_path;
        false
    }
}

fn read_log_lines(log_path: &str) -> Vec<LogLine> {
    let content = std::fs::read_to_string(log_path).unwrap_or_default();
    content
        .lines()
        .enumerate()
        .map(|(index, line)| LogLine { seq: index as u64 + 1, line: line.to_string(), event: parse_porcelain_line(line) })
        .collect()
}

/// What the porcelain lines add up to: whether `done ok` came, the profile
/// the installer provisioned (id, port and host are the installer's, read
/// from what `add-profile.sh` wrote — never re-derived here), and the first
/// failure if any.
fn summarize(lines: &[LogLine]) -> (bool, Option<ProfileResult>, Option<FailureInfo>) {
    let mut ok = false;
    let mut profile = None;
    let mut failure = None;
    for line in lines {
        match &line.event {
            Some(PorcelainEvent::Done { step, .. }) if step == "ok" => ok = true,
            Some(PorcelainEvent::Profile { fields }) => {
                if let Some(id) = fields.get("id") {
                    profile = Some(ProfileResult {
                        id: id.clone(),
                        port: fields.get("port").and_then(|p| p.parse().ok()),
                        host: fields.get("host").cloned(),
                        mode: fields.get("mode").cloned(),
                    });
                }
            }
            Some(PorcelainEvent::Fail { step, code, message }) if failure.is_none() => {
                failure = Some(FailureInfo { step: step.clone(), code: code.clone(), message: message.clone() });
            }
            _ => {}
        }
    }
    (ok, profile, failure)
}

fn status_of(state: &RunState) -> RunStatus {
    let lines = read_log_lines(&state.log_path);
    let (ok, profile, failure) = summarize(&lines);
    let alive = state.exit_code.is_none() && pid_is_installer(state.pid, &state.script_path);
    RunStatus {
        run_id: state.run_id.clone(),
        pid: state.pid,
        alive,
        cancelled: state.cancelled,
        exit_code: state.exit_code,
        started_at: state.started_at,
        params: state.params.clone(),
        lines,
        ok,
        profile,
        failure,
    }
}

/// Follows `<runId>.log` by polling and emits one `relay-setup-log` per
/// complete line, then `relay-setup-done` once the child is gone. Owns the
/// `Child` when this app started the run (so the exit code is real); for a
/// run re-attached after a relaunch it only has the pid, and "gone" is
/// `/proc` no longer naming the script — the exit code is then unknown and
/// the summary comes from the porcelain alone.
async fn tail_run(app: tauri::AppHandle, dir: PathBuf, mut state: RunState, mut child: Option<tokio::process::Child>) {
    let run_id = state.run_id.clone();
    let mut offset: u64 = 0;
    let mut seq: u64 = 0;
    let mut partial = String::new();
    let mut exit_code: Option<i32> = None;
    loop {
        // Drain whatever was appended since the last pass.
        if let Ok(mut file) = std::fs::File::open(&state.log_path) {
            if file.seek(SeekFrom::Start(offset)).is_ok() {
                let mut buffer = Vec::new();
                if file.read_to_end(&mut buffer).is_ok() && !buffer.is_empty() {
                    offset += buffer.len() as u64;
                    partial.push_str(&String::from_utf8_lossy(&buffer));
                    while let Some(newline) = partial.find('\n') {
                        let line = partial[..newline].trim_end_matches('\r').to_string();
                        partial.drain(..=newline);
                        seq += 1;
                        let _ = app.emit(
                            LOG_EVENT,
                            LogEvent { run_id: run_id.clone(), seq, line: line.clone(), event: parse_porcelain_line(&line) },
                        );
                    }
                }
            }
        }

        let gone = match child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => {
                    exit_code = status.code();
                    true
                }
                Ok(None) => false,
                Err(_) => true,
            },
            None => !pid_is_installer(state.pid, &state.script_path),
        };
        if gone {
            // One last pass picks up what the child wrote between the drain
            // above and its exit.
            if let Ok(mut file) = std::fs::File::open(&state.log_path) {
                if file.seek(SeekFrom::Start(offset)).is_ok() {
                    let mut buffer = Vec::new();
                    if file.read_to_end(&mut buffer).is_ok() {
                        partial.push_str(&String::from_utf8_lossy(&buffer));
                        for line in partial.lines() {
                            seq += 1;
                            let line = line.trim_end_matches('\r').to_string();
                            let _ = app.emit(
                                LOG_EVENT,
                                LogEvent { run_id: run_id.clone(), seq, line: line.clone(), event: parse_porcelain_line(&line) },
                            );
                        }
                    }
                }
            }
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // A run this app didn't start has no exit code to record; the porcelain
    // says how it ended. `-1` would be a lie, so it stays `None` there and
    // `ok`/`failure` carry the meaning.
    state.exit_code = exit_code.or(Some(if summarize(&read_log_lines(&state.log_path)).0 { 0 } else { 1 }));
    state.finished_at = Some(now_secs());
    let _ = write_state(&dir, &state);
    let status = status_of(&state);
    let _ = app.emit(
        DONE_EVENT,
        DoneEvent {
            run_id: run_id.clone(),
            exit_code: status.exit_code,
            ok: status.ok,
            profile: status.profile,
            failure: status.failure,
        },
    );
    if let Some(setup) = app.try_state::<RelaySetup>() {
        let mut inner = setup.0.lock().await;
        if inner.tailing.as_deref() == Some(run_id.as_str()) {
            inner.tailing = None;
        }
    }
}

fn ensure_tailing(app: &tauri::AppHandle, inner: &mut Inner, dir: &Path, state: &RunState, child: Option<tokio::process::Child>) {
    if inner.tailing.as_deref() == Some(state.run_id.as_str()) {
        return;
    }
    inner.tailing = Some(state.run_id.clone());
    let app = app.clone();
    let dir = dir.to_path_buf();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        tail_run(app, dir, state, child).await;
    });
}

async fn status_inner(app: &tauri::AppHandle, state: &tauri::State<'_, RelaySetup>) -> Result<Option<RunStatus>, String> {
    let dir = setup_dir(app)?;
    let Some(run) = read_state(&dir) else {
        return Ok(None);
    };
    let status = status_of(&run);
    if status.alive {
        // Re-attach to a run that outlived a previous launch of the app.
        let mut inner = state.0.lock().await;
        ensure_tailing(app, &mut inner, &dir, &run, None);
    }
    Ok(Some(status))
}

/// The whole state of the current (or last) run, from disk. What the UI
/// hydrates from on mount and after any gap in `seq`.
#[tauri::command]
pub async fn relay_setup_status(app: tauri::AppHandle, state: tauri::State<'_, RelaySetup>) -> Result<Option<RunStatus>, String> {
    status_inner(&app, &state).await
}

/// `filename`/`contents` pick which embedded script this run writes out —
/// `install-relay.sh` on Linux, `app-install.sh` (the Homebrew orchestration) on
/// macOS. The override env, when set, wins on either platform: a test can
/// point either flow at a fixture script.
fn write_script(dir: &Path, filename: &str, contents: &'static str) -> Result<PathBuf, String> {
    if let Some(override_path) = std::env::var_os(INSTALL_SCRIPT_OVERRIDE_ENV) {
        let path = PathBuf::from(override_path);
        if !path.is_file() {
            return Err(format!("{INSTALL_SCRIPT_OVERRIDE_ENV} points at no file: {}", path.display()));
        }
        return Ok(path);
    }
    let path = dir.join(filename);
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn create_log(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // The log echoes what the installer prints, which can include paths
        // under `--profile-home` and the agent's own messages — nobody else
        // on the machine gets to read it.
        options.mode(0o600);
    }
    options.open(path).map_err(|e| e.to_string())
}

/// The `--version` to pin the relay to: this app's own release, so the two
/// speak the same wire. `None` for a build from source that no release
/// stamped (it reports `0.0.0`, which has no release to download) — that one
/// installs the latest release instead.
fn relay_release_tag(app_version: &str) -> Option<String> {
    (app_version != UNRELEASED_VERSION).then(|| format!("v{app_version}"))
}

/// What an unstamped build reports — the same placeholder as
/// `UNRELEASED_VERSION` in appVersion.ts and scripts/version.mjs
/// (appVersion.test.ts keeps them in step).
const UNRELEASED_VERSION: &str = "0.0.0";

/// The relay tree this macOS app ships and where its running copy lives,
/// when it ships one (the Apple Silicon release; never a dev or Intel build).
///
/// A Mac that already has the Homebrew relay keeps it (it is left as is, not
/// migrated): its `default` profile is served by `brew services`, and a
/// launchd job for the same profile would fight it for the port. Such a Mac
/// takes the Homebrew path, as before.
#[cfg(target_os = "macos")]
fn bundled_relay(app: &tauri::AppHandle) -> Option<(PathBuf, PathBuf)> {
    if ["/opt/homebrew/opt/anywh-relay", "/usr/local/opt/anywh-relay"].iter().any(|path| Path::new(path).exists()) {
        return None;
    }
    Some((crate::macos_relay::bundled_tree(app)?, crate::macos_relay::support_dir(app)?))
}

#[cfg(not(target_os = "macos"))]
fn bundled_relay(_app: &tauri::AppHandle) -> Option<(PathBuf, PathBuf)> {
    None
}

/// Whether this app ships its own relay, so its app menu offers "Quit
/// Completely" (stop the local relay along with the app).
#[tauri::command]
pub fn relay_bundled(app: tauri::AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    return crate::macos_relay::bundled_tree(&app).is_some();
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

/// "Quit Completely": closing the app leaves the local relay running under
/// launchd (the phone keeps reaching this Mac); this stops it too, then
/// quits. The windows go first, so the app is gone from sight while the
/// relay drains a turn in flight.
#[tauri::command]
pub async fn relay_quit_completely(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        for window in app.webview_windows().values() {
            let _ = window.hide();
        }
        if let Some(support) = crate::macos_relay::support_dir(&app) {
            let launchd = crate::macos_relay::launchd_dir(&support);
            tauri::async_runtime::spawn_blocking(move || crate::macos_relay::stop_profiles(&launchd)).await.map_err(|e| e.to_string())?;
        }
    }
    app.exit(0);
    Ok(())
}

/// Starts the installer for this machine, or joins the run already alive.
#[tauri::command]
pub async fn relay_setup_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, RelaySetup>,
    params: StartParams,
) -> Result<RunInfo, String> {
    if !(cfg!(target_os = "linux") || cfg!(target_os = "macos")) {
        return Err("the in-app relay install is only available on Linux and macOS".to_string());
    }
    let mut inner = state.0.lock().await;
    let dir = setup_dir(&app)?;
    if BREW_UPGRADE_RUNNING.load(Ordering::SeqCst) {
        return Err("Homebrew is updating the relay right now; try again once it is done".to_string());
    }

    if let Some(existing) = read_state(&dir) {
        if existing.exit_code.is_none() && pid_is_installer(existing.pid, &existing.script_path) {
            ensure_tailing(&app, &mut inner, &dir, &existing, None);
            return Ok(RunInfo { run_id: existing.run_id, log_path: existing.log_path, started: false });
        }
    }

    match params.mode.as_deref() {
        None | Some("prod") | Some("dev") => {}
        Some(other) => return Err(format!("mode must be 'dev' or 'prod', got '{other}'")),
    }
    if params.relay_host.trim().is_empty() {
        return Err("relayHost is required".to_string());
    }
    if params.profile_id.is_none() && params.profile_label.as_deref().is_none_or(|l| l.trim().is_empty()) {
        return Err("profileId or profileLabel is required".to_string());
    }

    let is_macos = cfg!(target_os = "macos");
    // The running copy of the relay this app ships, brought up to date first
    // (the app may have been updated since it was opened).
    // A recursive copy of the whole tree: off the async runtime's threads.
    let bundled = match bundled_relay(&app) {
        Some((tree, support)) => {
            let synced = {
                let support = support.clone();
                tauri::async_runtime::spawn_blocking(move || crate::macos_relay::sync_tree(&tree, &support))
                    .await
                    .map_err(|e| e.to_string())?
            };
            Some((synced.map_err(|e| format!("couldn't set up the relay that came with the app: {e}"))?, support))
        }
        None => None,
    };
    let script_path = if bundled.is_some() {
        write_script(&dir, "bundled-profile.sh", BUNDLED_PROFILE_SCRIPT)?
    } else if is_macos {
        write_script(&dir, "app-install.sh", MACOS_INSTALL_SCRIPT)?
    } else {
        write_script(&dir, "install-relay.sh", INSTALL_SCRIPT)?
    };
    let run_id = format!("{}-{}", now_secs(), std::process::id());
    let log_path = dir.join(format!("{run_id}.log"));
    let log = create_log(&log_path)?;
    let log_for_stderr = log.try_clone().map_err(|e| e.to_string())?;

    let mut run = RunState {
        run_id: run_id.clone(),
        pid: 0,
        log_path: log_path.to_string_lossy().into_owned(),
        script_path: script_path.to_string_lossy().into_owned(),
        started_at: now_secs(),
        params: params.clone(),
        cancelled: false,
        exit_code: None,
        finished_at: None,
    };
    write_state(&dir, &run)?;

    let mut command = tokio::process::Command::new("bash");
    if let Some((relay, support)) = &bundled {
        command
            .arg(&script_path)
            .arg(relay.join("infra/systemd/add-profile.sh"))
            .arg(params.profile_id.as_deref().unwrap_or("default"))
            .args(["--porcelain", "--resume", "--relay-host", &params.relay_host])
            .args(["--mode", params.mode.as_deref().unwrap_or("prod")])
            // What makes add-profile.sh write launchd jobs, and where.
            .env("ANYWH_RELAY_MANAGED_BY_APP", "1")
            .env("ANYWH_LAUNCHD_DIR", crate::macos_relay::launchd_dir(support));
        if let Some(label) = &params.profile_label {
            command.args(["--label", label]);
        }
        if let Some(home) = &params.profile_home {
            command.args(["--home", home]);
        }
    } else if is_macos {
        command.arg(&script_path).args(["--porcelain", "--relay-host", &params.relay_host]);
        // The Homebrew launchd service is wired to the "default" profile
        // only (app-install.sh's own comment) — the id is never the
        // caller's to choose here, only the label is, and there is no
        // --version to pass: the tap's formula tracks the latest release
        // on its own, not whatever this app build was.
        if let Some(label) = &params.profile_label {
            command.args(["--profile-label", label]);
        }
    } else {
        command.arg(&script_path).args(["--porcelain", "--relay-host", &params.relay_host]);
        if let Some(tag) = relay_release_tag(&app.package_info().version.to_string()) {
            command.args(["--version", &tag]);
        }
        let mode = params.mode.clone().unwrap_or_else(|| "prod".to_string());
        command.args(["--mode", &mode]);
        if let Some(id) = &params.profile_id {
            command.args(["--profile-id", id]);
        }
        if let Some(label) = &params.profile_label {
            command.args(["--profile-label", label]);
        }
        if let Some(home) = &params.profile_home {
            command.args(["--profile-home", home]);
        }
    }
    // The child is meant to outlive this process (see the module doc), so
    // nothing here ties its lifetime to ours.
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_for_stderr))
        .kill_on_drop(false);
    // Its own process group, not the app's: `relay_setup_cancel` signals this
    // whole group, and the script forks further children of its own
    // (`brew install`, `add-profile.sh`, the `node` call inside it) that a
    // signal to just this PID would never reach — they'd run on as orphans
    // after the shell died, racing a retry that starts a second, unrelated
    // provisioning run against the same profile files.
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn().map_err(|e| format!("couldn't start the installer: {e}"))?;

    run.pid = child.id().unwrap_or(0);
    write_state(&dir, &run)?;
    ensure_tailing(&app, &mut inner, &dir, &run, Some(child));

    Ok(RunInfo { run_id, log_path: run.log_path, started: true })
}

/// Asks the installer to stop. SIGTERM, not SIGKILL: the script's EXIT trap
/// is what sweeps a half-extracted staging tree, and it only runs if the
/// shell gets to run it. Sent to the whole process group (`-pid`, matching
/// the `process_group(0)` set at spawn), not just the shell's own PID: the
/// shell forks children of its own for the heavy lifting (`brew install`,
/// `add-profile.sh`), and a signal to only the parent would leave those
/// running as orphans that finish the provisioning a "cancelled" run was
/// supposed to stop — and then collide with whatever a retry starts next.
#[tauri::command]
pub async fn relay_setup_cancel(app: tauri::AppHandle, state: tauri::State<'_, RelaySetup>) -> Result<(), String> {
    let _inner = state.0.lock().await;
    let dir = setup_dir(&app)?;
    let Some(mut run) = read_state(&dir) else {
        return Ok(());
    };
    if run.exit_code.is_none() && pid_is_installer(run.pid, &run.script_path) {
        #[cfg(unix)]
        {
            // `--` before the negative pid: procps-ng's `kill` misparses a
            // bare `-TERM -1234` (it exits 1 as if `-1234` were a second,
            // invalid signal spec) even though it still signals the group —
            // `--` ends option parsing so there's nothing left to misread.
            let _ = std::process::Command::new("kill").args(["-TERM", "--", &format!("-{}", run.pid)]).status();
        }
    }
    run.cancelled = true;
    write_state(&dir, &run)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_the_relay_to_this_release_but_not_to_an_unstamped_build() {
        assert_eq!(relay_release_tag("0.2.0").as_deref(), Some("v0.2.0"));
        assert_eq!(relay_release_tag("0.0.0"), None);
    }

    #[test]
    fn a_failed_brew_run_is_told_by_its_error_line_not_its_progress() {
        // Homebrew's progress goes to stdout, several lines of it after the
        // failure; its reason goes to stderr.
        let stderr = "Warning: something unrelated\nError: anywh-relay: SHA256 mismatch\nExpected: abc\n";
        let stdout = "==> Fetching anywh-relay\n==> Downloading https://example/a.tar.gz\n######## 100.0%\n==> Cleaning up\n";
        assert_eq!(failure_tail(stdout, stderr), "Error: anywh-relay: SHA256 mismatch");
        // No Error: line: the end of stderr, still never stdout's progress.
        assert_eq!(failure_tail(stdout, "a\nb\nc\nd\n"), "b c d");
        // Nothing on stderr at all: the end of stdout.
        assert_eq!(failure_tail("one\ntwo\n\nthree\nfour\n", ""), "two three four");
        assert_eq!(failure_tail("", ""), "");
    }

    #[test]
    fn a_brew_run_ends_in_a_code_for_the_app_never_an_english_sentence() {
        assert_eq!(brew_outcome(Some(0), "anything", "Warning: x"), Ok(()));
        assert_eq!(
            brew_outcome(Some(1), "", "Error: anywh-relay: SHA256 mismatch\n"),
            Err(BrewUpgradeError { code: "failed", detail: Some("Error: anywh-relay: SHA256 mismatch".into()) })
        );
        // Killed by a signal, and said nothing: no empty detail to show.
        assert_eq!(brew_outcome(None, "", ""), Err(BrewUpgradeError { code: "failed", detail: None }));
        // The shape the app reads.
        let json = serde_json::to_value(BrewUpgradeError::new("timeout")).unwrap();
        assert_eq!(json, serde_json::json!({ "code": "timeout" }));
    }

    /// What a timed-out Homebrew run leaves behind: nothing. The script
    /// stands in for `bash -lc` starting `brew`, which forks more of its own.
    #[test]
    #[cfg(unix)]
    fn a_brew_run_past_its_limit_is_stopped_with_everything_it_started() {
        let dir = std::env::temp_dir().join(format!("anywh-brew-timeout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("grandchild.pid");
        let script = format!("sleep 30 & echo $! > '{}'; wait", pid_file.display());
        let outcome = tauri::async_runtime::block_on(run_in_own_group(&["-c", &script], Duration::from_millis(500)));
        assert_eq!(outcome.err(), Some(BrewUpgradeError::new("timeout")));

        let grandchild = std::fs::read_to_string(&pid_file).unwrap().trim().to_string();
        // Polled: the signal lands at once, the exit takes a moment, and a
        // zombie still answers `kill -0` until it is reaped.
        let gone = (0..50).any(|_| {
            let alive = std::process::Command::new("kill")
                .args(["-0", &grandchild])
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
            let zombie = std::fs::read_to_string(format!("/proc/{grandchild}/stat")).is_ok_and(|stat| stat.contains(") Z "));
            if alive && !zombie {
                std::thread::sleep(Duration::from_millis(100));
            }
            !alive || zombie
        });
        assert!(gone, "the grandchild outlived the timeout");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_relay_naming_another_machine_is_not_this_one() {
        assert!(same_machine("Mac-mini.local", "Mac-mini.local"));
        assert!(same_machine("mac-mini.local", "Mac-mini.local"));
        assert!(!same_machine("studio.local", "Mac-mini.local"));
        assert!(same_machine("", "Mac-mini.local"));
    }

    #[test]
    fn one_brew_upgrade_at_a_time() {
        let first = BrewUpgradeRunning::claim().expect("nothing else is running");
        assert!(BrewUpgradeRunning::claim().is_none(), "a second run started next to the first");
        drop(first);
        assert!(BrewUpgradeRunning::claim().is_some(), "the flag outlived its run");
    }

    #[test]
    fn the_brew_update_finds_homebrew_without_the_zsh_profile() {
        assert!(BREW_UPGRADE_COMMAND.starts_with("PATH=/opt/homebrew/bin:/usr/local/bin:$PATH;"));
    }

    /// The command line itself, run by a real shell against a stand-in
    /// `brew` that records what it was asked and says whether the formula
    /// is outdated.
    #[test]
    #[cfg(unix)]
    fn the_brew_update_restarts_the_relay_only_when_the_tap_has_a_newer_one() {
        use std::os::unix::fs::PermissionsExt;
        if std::path::Path::new("/opt/homebrew/bin/brew").exists() || std::path::Path::new("/usr/local/bin/brew").exists() {
            // A real Homebrew would come first on PATH; never run it here.
            return;
        }
        let dir = std::env::temp_dir().join(format!("anywh-fake-brew-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("calls");
        let brew = dir.join("brew");
        std::fs::write(
            &brew,
            format!(
                "#!/bin/sh\necho \"$*\" >> '{}'\nif [ \"$1\" = outdated ] && [ -n \"$FAKE_OUTDATED\" ]; then echo anywh-relay; fi\nexit 0\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&brew, std::fs::Permissions::from_mode(0o755)).unwrap();
        let run = |outdated: bool| {
            std::fs::remove_file(&log).ok();
            let mut command = std::process::Command::new("bash");
            command.args(["-c", BREW_UPGRADE_COMMAND]).env("PATH", format!("{}:/usr/bin:/bin", dir.display()));
            if outdated {
                command.env("FAKE_OUTDATED", "1");
            }
            let status = command.status().unwrap().code();
            (status, std::fs::read_to_string(&log).unwrap_or_default())
        };

        let (status, calls) = run(true);
        assert_eq!(status, Some(0));
        assert_eq!(calls, "update\nlist --versions anywh-relay\noutdated --quiet anywh-relay\nupgrade anywh-relay\nservices restart anywh-relay\n");

        let (status, calls) = run(false);
        assert_eq!(status, Some(BREW_NOTHING_NEWER));
        assert!(!calls.contains("upgrade anywh-relay\n") && !calls.contains("services"), "restarted with nothing newer: {calls}");
        assert_eq!(brew_outcome(status, "", ""), Err(BrewUpgradeError::new("nothing_newer")));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The move to the app's relay, run by a real shell against stand-ins
    /// for `brew`, `launchctl` and the app's `add-profile.sh` (which, like
    /// the real one, brings up a relay on the profile's port, or doesn't).
    #[test]
    #[cfg(unix)]
    fn a_homebrew_relay_moves_to_the_apps_relay_and_is_put_back_when_that_fails() {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::process::CommandExt;
        if std::path::Path::new("/opt/homebrew/bin/brew").exists() || std::path::Path::new("/usr/local/bin/brew").exists() {
            // A real Homebrew would come first on PATH; never run it here.
            return;
        }
        let dir = std::env::temp_dir().join(format!("anywh-brew-migrate-{}", std::process::id()));
        let (bin, env_dir, launchd) = (dir.join("bin"), dir.join("env"), dir.join("launchd"));
        for d in [&bin, &env_dir, &launchd] {
            std::fs::create_dir_all(d).unwrap();
        }
        let log = dir.join("calls");
        let script = |name: &str, body: &str| {
            let path = bin.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        script("brew", &format!("echo \"brew $*\" >> '{}'\nexit 0\n", log.display()));
        script("launchctl", &format!("echo \"launchctl $1\" >> '{}'\nexit 0\n", log.display()));
        let add_profile = script(
            "add-profile.sh",
            &format!(
                concat!(
                    "echo \"add-profile $* managed=$ANYWH_RELAY_MANAGED_BY_APP launchd=$ANYWH_LAUNCHD_DIR\" >> '{}'\n",
                    "if [ -n \"${{FAKE_SLEEP:-}}\" ]; then sleep \"$FAKE_SLEEP\"; fi\n",
                    "if [ -n \"${{FAKE_LISTEN:-}}\" ]; then python3 -c 'import socket,sys,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((\"127.0.0.1\", int(sys.argv[1]))); s.listen(); time.sleep(3)' \"$FAKE_LISTEN\" </dev/null >/dev/null 2>&1 & sleep 0.5; fi\n",
                    "exit \"${{FAKE_ADD_PROFILE_EXIT:-0}}\"\n",
                ),
                log.display()
            ),
        );
        let free_port = || std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let command = |port: u16, fake: &[(&str, String)]| {
            std::fs::remove_file(&log).ok();
            std::fs::write(env_dir.join("default.env"), format!("RELAY_HOST=127.0.0.1\nRELAY_PORT={port}\n")).unwrap();
            let mut command = std::process::Command::new("bash");
            command
                .args(["-c", BREW_MIGRATE_SCRIPT, "brew-migrate"])
                .arg(&add_profile)
                .arg(&launchd)
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .env("ANYWH_ENV_DIR", &env_dir)
                .env("LAUNCHCTL_BIN", bin.join("launchctl"))
                .env("ANYWH_RELAY_READY_TRIES", "5");
            for (key, value) in fake {
                command.env(key, value);
            }
            command
        };
        let run = |port: u16, fake: &[(&str, String)]| {
            let output = command(port, fake).output().unwrap();
            let outcome = brew_outcome(output.status.code(), &String::from_utf8_lossy(&output.stdout), &String::from_utf8_lossy(&output.stderr));
            (outcome, std::fs::read_to_string(&log).unwrap_or_default())
        };
        let put_back = |calls: &str| calls.contains("launchctl bootout\nlaunchctl bootout\n") && calls.ends_with("brew services start anywh-relay\n") && !calls.contains("uninstall");

        // The app's relay comes up on the profile's port: the formula goes.
        let port = free_port();
        let (outcome, calls) = run(port, &[("FAKE_LISTEN", port.to_string())]);
        assert_eq!(outcome, Ok(()));
        assert_eq!(
            calls,
            format!(
                "brew list --versions anywh-relay\nbrew services stop anywh-relay\nadd-profile default --resume --mode prod managed=1 launchd={}\nbrew uninstall anywh-relay\n",
                launchd.display()
            )
        );

        // The profile could not be moved: Homebrew's service comes back.
        let (outcome, calls) = run(free_port(), &[("FAKE_ADD_PROFILE_EXIT", "1".into())]);
        assert_eq!(outcome, Err(BrewUpgradeError::with_detail("failed", "Error: couldn't move the profile to the app's relay".into())));
        assert!(put_back(&calls), "{calls}");

        // Moved, but nothing answers: its jobs go and Homebrew's come back.
        let closed = free_port();
        let (outcome, calls) = run(closed, &[]);
        assert_eq!(outcome, Err(BrewUpgradeError::with_detail("failed", format!("Error: the app's relay didn't answer on 127.0.0.1:{closed}"))));
        assert!(put_back(&calls), "{calls}");

        // The old relay still holds the port: nothing is moved onto it.
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (outcome, calls) = run(held.local_addr().unwrap().port(), &[]);
        assert!(matches!(&outcome, Err(e) if e.detail.as_deref().is_some_and(|d| d.contains("didn't let go"))), "{outcome:?}");
        assert!(!calls.contains("add-profile") && put_back(&calls), "{calls}");
        drop(held);

        // Cut off mid-move (the app quit): Homebrew's relay comes back.
        let mut child = command(free_port(), &[("FAKE_SLEEP", "5".into())]).process_group(0).spawn().unwrap();
        let started = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(100));
            std::fs::read_to_string(&log).is_ok_and(|calls| calls.contains("add-profile"))
        });
        assert!(started, "the move never reached add-profile");
        std::process::Command::new("kill").args(["-TERM", "--", &format!("-{}", child.id())]).status().unwrap();
        child.wait().unwrap();
        let calls = std::fs::read_to_string(&log).unwrap();
        assert!(put_back(&calls), "{calls}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn node_threshold_is_20_12() {
        assert!(!node_version_ok("20.11.1"));
        assert!(node_version_ok("20.12.0"));
        assert!(node_version_ok("v22.4.0"));
        assert!(!node_version_ok("18.20.4"));
        assert!(!node_version_ok("garbage"));
    }

    #[test]
    fn classifies_addresses_by_prefix() {
        assert_eq!(classify_ipv4("127.0.0.1".parse().unwrap()), AddressKind::Loopback);
        assert_eq!(classify_ipv4("100.64.0.1".parse().unwrap()), AddressKind::Tailnet);
        assert_eq!(classify_ipv4("100.127.255.254".parse().unwrap()), AddressKind::Tailnet);
        assert_eq!(classify_ipv4("100.63.0.1".parse().unwrap()), AddressKind::Public);
        assert_eq!(classify_ipv4("100.128.0.1".parse().unwrap()), AddressKind::Public);
        assert_eq!(classify_ipv4("10.1.2.3".parse().unwrap()), AddressKind::Lan);
        assert_eq!(classify_ipv4("172.16.0.1".parse().unwrap()), AddressKind::Lan);
        assert_eq!(classify_ipv4("172.31.255.1".parse().unwrap()), AddressKind::Lan);
        // The off-by-one: 172.32/12 is public space.
        assert_eq!(classify_ipv4("172.32.0.1".parse().unwrap()), AddressKind::Public);
        assert_eq!(classify_ipv4("192.168.7.7".parse().unwrap()), AddressKind::Lan);
        assert_eq!(classify_ipv4("192.169.0.1".parse().unwrap()), AddressKind::Public);
    }

    fn iface(name: &str, ip: &str) -> (String, Ipv4Addr) {
        (name.to_string(), ip.parse().unwrap())
    }

    #[test]
    fn recommends_the_tailnet_address_over_a_lan_one() {
        let out = suggest_addresses([iface("enp1s0", "192.168.0.48"), iface("tailscale0", "100.99.146.5"), iface("lo", "127.0.0.1")]);
        assert_eq!(out.iter().map(|c| c.kind).collect::<Vec<_>>(), vec![AddressKind::Tailnet, AddressKind::Lan, AddressKind::Loopback]);
        assert!(out[0].recommended && out[0].address == "100.99.146.5");
        assert!(out.iter().filter(|c| c.recommended).count() == 1);
    }

    #[test]
    fn recommends_a_single_lan_address_and_none_when_several() {
        let one = suggest_addresses([iface("eth0", "10.0.0.5"), iface("docker0", "172.17.0.1"), iface("lo", "127.0.0.1")]);
        assert!(one.iter().all(|c| c.interface != "docker0"));
        assert!(one.iter().any(|c| c.recommended && c.address == "10.0.0.5"));

        let two = suggest_addresses([iface("eth0", "10.0.0.5"), iface("wlan0", "192.168.1.9")]);
        assert!(two.iter().all(|c| !c.recommended));
    }

    #[test]
    fn loopback_is_never_recommended() {
        let out = suggest_addresses([iface("lo", "127.0.0.1")]);
        assert_eq!(out.len(), 1);
        assert!(!out[0].recommended);
    }

    #[test]
    fn parses_the_porcelain_vocabulary() {
        assert_eq!(parse_porcelain_line("ANYWH step download"), Some(PorcelainEvent::Step { step: "download".into() }));
        let done = parse_porcelain_line("ANYWH done target os=Linux arch=x86_64 service=systemd").unwrap();
        match done {
            PorcelainEvent::Done { step, fields } => {
                assert_eq!(step, "target");
                assert_eq!(fields.get("service").map(String::as_str), Some("systemd"));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(
            parse_porcelain_line("ANYWH fail prereqs agent_not_logged_in 'claude' isn't logged in — run it"),
            Some(PorcelainEvent::Fail {
                step: "prereqs".into(),
                code: "agent_not_logged_in".into(),
                message: "'claude' isn't logged in — run it".into(),
            })
        );
        let profile = parse_porcelain_line("ANYWH profile id=home port=8766 host=100.99.146.5 mode=prod env=/x/home.env").unwrap();
        match profile {
            PorcelainEvent::Profile { fields } => assert_eq!(fields.get("port").map(String::as_str), Some("8766")),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(parse_porcelain_line("Downloading anywh-relay-linux-x64.tar.gz..."), None);
        assert_eq!(parse_porcelain_line("ANYWH bogus x"), None);
        assert_eq!(parse_porcelain_line("ANYWH done ok service=systemd"), Some(PorcelainEvent::Done { step: "ok".into(), fields: parse_fields("service=systemd") }));
    }

    #[test]
    fn summarizes_a_run_from_its_porcelain() {
        let lines: Vec<LogLine> = [
            "ANYWH step install",
            "Installed to /home/x/.local/share/anywh",
            "ANYWH done install dir=/home/x/.local/share/anywh",
            "ANYWH profile id=home port=8766 host=100.99.146.5 mode=prod env=/e/home.env",
            "ANYWH done ok service=systemd install_dir=/home/x/.local/share/anywh",
        ]
        .iter()
        .enumerate()
        .map(|(i, l)| LogLine { seq: i as u64 + 1, line: l.to_string(), event: parse_porcelain_line(l) })
        .collect();
        let (ok, profile, failure) = summarize(&lines);
        assert!(ok);
        assert_eq!(profile, Some(ProfileResult { id: "home".into(), port: Some(8766), host: Some("100.99.146.5".into()), mode: Some("prod".into()) }));
        assert!(failure.is_none());

        let failed: Vec<LogLine> = ["ANYWH step download", "ANYWH fail download checksum_mismatch checksum mismatch for x"]
            .iter()
            .enumerate()
            .map(|(i, l)| LogLine { seq: i as u64 + 1, line: l.to_string(), event: parse_porcelain_line(l) })
            .collect();
        let (ok, _, failure) = summarize(&failed);
        assert!(!ok);
        assert_eq!(failure.map(|f| f.code), Some("checksum_mismatch".into()));
    }

    fn fixture_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("anywh-relay-setup-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn probe_reads_profiles_and_flags_an_orphan_default() {
        let root = fixture_dir("probe");
        let install = root.join("install");
        std::fs::create_dir_all(install.join("relay/dist")).unwrap();
        std::fs::write(install.join("relay/dist/server.js"), "// relay").unwrap();
        std::fs::write(install.join("relay/package.json"), r#"{"name":"relay","version":"0.1.1"}"#).unwrap();
        let env = root.join("config/anywh/env");
        std::fs::create_dir_all(&env).unwrap();
        std::fs::write(env.join("home.env"), "RELAY_PORT=8766\nRELAY_HOST=100.99.146.5\n# comment\nANYWH_EDITOR_LOCAL=1\n").unwrap();
        std::fs::write(env.join("default.env"), "RELAY_PORT=8765\nRELAY_HOST=127.0.0.1\n").unwrap();
        std::fs::write(
            root.join("config/anywh/profiles.json"),
            r#"{"version":1,"profiles":[{"id":"home","label":"Home","colorIndex":0}]}"#,
        )
        .unwrap();
        let systemd = root.join("systemd/user");
        std::fs::create_dir_all(&systemd).unwrap();
        std::fs::write(systemd.join("anywh-relay@.service"), "[Unit]").unwrap();

        let (installed, version, unit, profiles, orphan) = probe_dirs(&install, &env, &systemd);
        assert!(installed);
        assert_eq!(version.as_deref(), Some("0.1.1"));
        assert!(unit);
        assert!(orphan);
        assert_eq!(profiles.len(), 2);
        let home = profiles.iter().find(|p| p.id == "home").unwrap();
        assert_eq!(home.label.as_deref(), Some("Home"));
        assert_eq!(home.port, Some(8766));
        assert!(home.registered);
        let default = profiles.iter().find(|p| p.id == "default").unwrap();
        assert!(!default.registered);
        assert_eq!(default.host.as_deref(), Some("127.0.0.1"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn probe_on_an_empty_machine_reports_nothing() {
        let root = fixture_dir("empty");
        let (installed, version, unit, profiles, orphan) =
            probe_dirs(&root.join("nope"), &root.join("nope/env"), &root.join("nope/systemd"));
        assert!(!installed && version.is_none() && !unit && profiles.is_empty() && !orphan);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn events_serialize_in_camel_case() {
        // `app.emit` uses plain serde, so without `rename_all` the JS
        // listener reads `run_id` and gets `undefined` for `runId` — the
        // Windows bug notifications.rs documents.
        let json = serde_json::to_string(&LogEvent {
            run_id: "r1".into(),
            seq: 3,
            line: "ANYWH step install".into(),
            event: parse_porcelain_line("ANYWH step install"),
        })
        .unwrap();
        assert!(json.contains("\"runId\":\"r1\""));
        assert!(!json.contains("run_id"));
        assert!(json.contains("\"kind\":\"step\""));

        let json = serde_json::to_string(&DoneEvent { run_id: "r1".into(), exit_code: Some(0), ok: true, profile: None, failure: None }).unwrap();
        assert!(json.contains("\"exitCode\":0"));
    }

    #[test]
    fn state_round_trips_and_tolerates_missing_optionals() {
        let state = RunState {
            run_id: "r".into(),
            pid: 42,
            log_path: "/l".into(),
            script_path: "/s".into(),
            started_at: 1,
            params: StartParams { profile_id: Some("home".into()), profile_label: None, relay_host: "10.0.0.1".into(), profile_home: None, mode: None },
            cancelled: false,
            exit_code: None,
            finished_at: None,
        };
        let json = serde_json::to_string(&state).unwrap();
        assert_eq!(serde_json::from_str::<RunState>(&json).unwrap(), state);
        // An older state.json without the fields added later still loads.
        let minimal = r#"{"runId":"r","pid":1,"logPath":"/l","scriptPath":"/s","startedAt":1,"params":{"profileId":"a","profileLabel":null,"relayHost":"h","profileHome":null,"mode":null}}"#;
        assert!(serde_json::from_str::<RunState>(minimal).is_ok());
    }

    #[test]
    fn embedded_installer_is_the_real_one() {
        // `include_str!` with a path outside the crate breaks in a vendored
        // build, and an older script wouldn't understand the flags this
        // module passes — both would show up here first.
        assert!(INSTALL_SCRIPT.starts_with("#!/usr/bin/env bash"));
        for flag in ["--porcelain", "--relay-host", "--profile-id", "--mode", "--version"] {
            assert!(INSTALL_SCRIPT.contains(flag), "install-relay.sh lacks {flag}");
        }
        assert!(INSTALL_SCRIPT.contains("ANYWH done ok"));
        // Points at the relay installer, not at install.sh — the front door
        // accepts the same flags and would satisfy every assertion above
        // while doing none of this module's work itself.
        assert!(
            INSTALL_SCRIPT.contains("add-profile.sh"),
            "INSTALL_SCRIPT isn't install-relay.sh — check the include_str! path"
        );
    }

    #[test]
    fn embedded_macos_installer_runs_the_documented_brew_command() {
        // The landing page and homebrew-tap/README.md both show
        // "brew install anywh-sh/tap/anywh-relay" as *the* command — this
        // guards against the in-app installer ever drifting from it.
        assert!(MACOS_INSTALL_SCRIPT.starts_with("#!/usr/bin/env bash"));
        assert!(MACOS_INSTALL_SCRIPT.contains("brew install anywh-sh/tap/anywh-relay"));
        assert!(MACOS_INSTALL_SCRIPT.contains("brew services start anywh-relay"));
        for flag in ["--porcelain", "--relay-host", "--profile-label"] {
            assert!(MACOS_INSTALL_SCRIPT.contains(flag), "app-install.sh lacks {flag}");
        }
        assert!(MACOS_INSTALL_SCRIPT.contains("ANYWH done ok"));
    }

    #[test]
    fn pid_zero_is_never_alive() {
        assert!(!pid_is_installer(0, "/x/install-relay.sh"));
    }

    /// `wait_for_relay` (infra/lib.sh) is the whole of the fix for an
    /// install that reported success a beat before the relay could answer:
    /// neither `systemctl --user enable --now` nor `brew services start`
    /// waits for the process to bind, and the wizard dials the relay the
    /// instant the installer exits. Run against a real socket rather than
    /// grepped for as a string — "it blocks until something accepts a
    /// connection, and gives up instead of hanging" is a behaviour, and
    /// the shell function is the only place it exists.
    #[test]
    #[cfg(unix)]
    fn wait_for_relay_blocks_until_the_port_accepts_connections() {
        let dir = std::env::temp_dir().join(format!("anywh-lib-sh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create the scratch dir");
        let lib = dir.join("lib.sh");
        std::fs::write(&lib, include_str!("../../../infra/lib.sh")).expect("write lib.sh");

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a stand-in relay");
        let port = listener.local_addr().unwrap().port();
        let run = |port: u16, timeout: &str| {
            std::process::Command::new("bash")
                .arg("-c")
                .arg(format!("source {}; wait_for_relay 127.0.0.1 {port}", lib.display()))
                .env("ANYWH_RELAY_READY_TIMEOUT", timeout)
                .status()
                .expect("run wait_for_relay")
        };

        assert!(run(port, "5").success(), "wait_for_relay didn't see a port that was listening");

        // Nothing listening: it has to come back with a status the caller
        // can branch on, not hang and not take the installer down with it.
        //
        // Not the port just closed: it is an ephemeral one, and freed it can
        // be handed to another test running alongside, or a connect to it
        // can pick it as its own source port and connect to itself — either
        // makes it "ready". Port 1 is outside the ephemeral range and only
        // root could listen on it.
        drop(listener);
        let started = std::time::Instant::now();
        assert!(!run(1, "1").success(), "wait_for_relay called a closed port ready");
        assert!(started.elapsed() >= Duration::from_millis(900), "it gave up before the timeout it was given");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The exact primitive `relay_setup_cancel` relies on: spawn a script
    /// with `process_group(0)`, then signal `-pid` instead of `pid`. Without
    /// both halves, a script's own child (`brew install`, `add-profile.sh`
    /// and the `node` call inside it, in the real installer) is left running
    /// as an orphan after "cancel" — the bug a retry right after cancelling
    /// used to hit, since that orphan kept writing the profile the new run
    /// was also trying to write.
    #[test]
    #[cfg(unix)]
    fn cancel_signal_reaches_a_child_the_script_forked() {
        use std::io::BufRead;
        use std::os::unix::process::CommandExt;

        let mut parent = std::process::Command::new("bash")
            .arg("-c")
            // Stands in for install-relay.sh spawning `add-profile.sh`/`brew
            // install` in the foreground: a child of its own, printed so the
            // test can check on it independently, then waited on.
            .arg("sleep 30 & echo $!; wait")
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn the stand-in installer");
        let pid = parent.id();

        let mut line = String::new();
        std::io::BufReader::new(parent.stdout.take().expect("piped stdout"))
            .read_line(&mut line)
            .expect("read the forked child's pid");
        let child_pid: i32 = line.trim().parse().expect("a pid on the first line");

        // Same call relay_setup_cancel makes: SIGTERM to the group, not just
        // the shell's own pid.
        let status = std::process::Command::new("kill").args(["-TERM", "--", &format!("-{pid}")]).status().expect("run kill");
        assert!(status.success());
        parent.wait().expect("the shell exits once signalled");

        // `kill -0` on an already-gone pid prints "No such process" to
        // stderr, which is the expected outcome here — silenced so a
        // passing run doesn't look like it logged an error. Polled rather
        // than checked once: the signal reaches the child at once, but it
        // takes a moment to exit, and once the shell is gone it lingers as a
        // zombie until init reaps it — `kill -0` still succeeds on a zombie.
        // Checked once, a slow CI runner failed the test with the child
        // already on its way out.
        let is_alive = || {
            std::process::Command::new("kill")
                .args(["-0", &child_pid.to_string()])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success()
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while is_alive() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // A child the signal never reached is still sleeping (30 s) here.
        assert!(!is_alive(), "the script's own child survived a cancel that only reached the shell");
    }
}
