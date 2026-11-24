//! The real Tauri↔sidecar bridge — supersedes the spike
//! probes (`tailnet_sidecar_probe`/`tailnet_sidecar_probe_listen`, both
//! already validated the exact spawn/stdout mechanics used here and are
//! gone now that the real thing exists). The sidecar itself stays ignorant
//! of the control plane's API the whole time: these commands only
//! ever pass it Ed25519/tsnet primitives — a file path, a method/path/body
//! to sign, an auth key/control URL/target to join a tailnet with — never a
//! header name, a route, or anything that would make this module (or the
//! Go binary it spawns) know it's talking to anywh specifically.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

/// One running `tailnet-up` child per profile, keyed by `Profile.id` — tabs
/// sharing the same profile share the same tailnet join and local port
/// instead of each opening a redundant one (the ephemeral `-listen
/// 127.0.0.1:0` port exists to avoid collision *between different
/// profiles*, not between tabs of the same one). A single
/// `tokio::sync::Mutex` held for the whole start-or-join operation (not
/// just the map access) also means two tabs racing to open the same
/// profile at once can't both win and spawn two sidecars for it — the
/// second one simply finds the first's entry once it gets the lock.
#[derive(Default)]
pub struct TailnetSidecars(Mutex<HashMap<String, Running>>);

struct Running {
    child: CommandChild,
    addr: String,
    /// What this child dials inside the tailnet (`-target`). A brokered
    /// profile's target can move (a recreated sandbox joins as a new node
    /// with a new address), and the child can't be repointed, only replaced.
    target: String,
}

/// The last timestamp `tailnet_sidecar_sign` handed out, so the next one is
/// strictly greater. A signature covers method/path/ts/body and nothing else,
/// and a broker request's body is empty: two signs of the same request in the
/// same millisecond (pairing verify and the relay client both asking for a
/// grant at once) would be byte-identical, and the control plane keys its
/// replay check on the signature, so the second one came back 401 `replayed`.
/// Per process rather than per identity file: there is one identity per
/// install, and a process-wide sequence is strictly stronger anyway.
#[derive(Default)]
pub struct SignClock(std::sync::Mutex<i64>);

impl SignClock {
    /// `max(now, last + 1)`, reserved under the lock so concurrent callers
    /// never get the same value. Running ahead of the wall clock by a few ms
    /// under a burst is harmless: the broker's freshness window is minutes.
    fn next(&self, now_ms: i64) -> i64 {
        let mut last = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let ts = now_ms.max(*last + 1);
        *last = ts;
        ts
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Where a profile's tailnet node keeps the identity it earned when its
/// pre-auth key was spent. That key is single use and expires in 15 minutes,
/// so this directory surviving is the only thing that lets the profile rejoin the
/// tailnet later — losing it means re-pairing, not just a slower start.
/// Per profile: two profiles sharing one directory would fight over a
/// single node identity.
fn tailnet_state_dir(app: &tauri::AppHandle, profile_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tailnet-state")
        .join(sanitize_for_path(profile_id));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Keeps a profile id usable as both a directory name and part of a tailnet
/// hostname — profile ids are generated locally (a UUID for an imported
/// profile, a slug for a hand-made one) and never validated against either
/// alphabet.
fn sanitize_for_path(profile_id: &str) -> String {
    let cleaned: String = profile_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    if cleaned.is_empty() {
        "profile".to_string()
    } else {
        cleaned
    }
}

/// The name this device shows up as in the tenant's tailnet. Has to match
/// `node_id` byte-for-byte, no prefix or truncation: the control plane's
/// own hostname cross-check
/// does a plain string comparison against `node.id`, not a
/// pattern match — a shortened/prefixed form (the previous
/// `ultron-<12 chars>` of the pre-rebrand build, live-confirmed via a WebdriverIO e2e run against
/// production) never matches and the device sits unbound forever. `node_id`
/// is `Profile.brokerNodeId` for a brokered profile, or `Profile.id` for a
/// manually configured one (no broker to reconcile against, so nothing to
/// match) — both are always a UUID already (`crypto.randomUUID()` on the JS
/// side), well inside the 63-character DNS label limit, so sanitizing here
/// is defense-in-depth against a malformed input, not an expected transform.
fn tailnet_hostname(node_id: &str) -> String {
    sanitize_for_path(node_id)
}

/// Where the device's Ed25519 identity file lives — same directory Tauri
/// already uses for other per-install state (`voice.rs`'s Whisper model),
/// not guaranteed to exist yet on a fresh install.
fn identity_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("tailnet-identity"))
}

/// Generates (or loads, if it already exists) the device's Ed25519 keypair
/// and returns its public key, base64 — the same shape `POST /v1/nodes` and
/// `POST /v1/nodes/claim` already expect on the control-plane side. The
/// private key never leaves the sidecar's file.
#[tauri::command]
pub async fn tailnet_sidecar_identity(app: tauri::AppHandle) -> Result<String, String> {
    let path = identity_path(&app)?;
    let sidecar = app
        .shell()
        .sidecar("tailnet-sidecar")
        .map_err(|e| e.to_string())?
        .args(["identity", "-path", &path.to_string_lossy()]);
    let output = sidecar.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[derive(Serialize, Deserialize)]
pub struct SignResult {
    ts: i64,
    sig: String,
}

/// What a cold `tailnet_sidecar_start` resolves to — an already-running
/// sidecar's second (and later) caller gets `node_key: None`, since the
/// report (JS side, tailnetBroker.ts) only needs to happen once per join,
/// not once per caller.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailnetUpResult {
    addr: String,
    node_key: Option<String>,
}

/// Signs an HTTP request's method/path/body with the device identity, in
/// the exact format the control plane's request-signature verification expects.
/// Generic on purpose: this command has no idea what the path means
/// or what will be done with the signature — whoever calls it from JS is
/// the one that knows it's building a request against a specific broker.
///
/// The timestamp is chosen here, not by the sidecar (`SignClock`), so every
/// signature this process produces is unique even for identical requests.
#[tauri::command]
pub async fn tailnet_sidecar_sign(
    app: tauri::AppHandle,
    clock: tauri::State<'_, SignClock>,
    method: String,
    path: String,
    body: String,
) -> Result<SignResult, String> {
    let identity = identity_path(&app)?;
    let ts = clock.next(now_ms()).to_string();
    let sidecar = app
        .shell()
        .sidecar("tailnet-sidecar")
        .map_err(|e| e.to_string())?
        .args([
            "sign",
            "-identity",
            &identity.to_string_lossy(),
            "-method",
            &method,
            "-path",
            &path,
            "-body",
            &body,
            "-ts",
            &ts,
        ]);
    let output = sidecar.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

/// Starts (or joins an already-running) `tailnet-up` for `profile_id` and
/// returns its local listen address (`host:port`) once the sidecar's
/// stdout confirms it's up — same `LISTENING host:port` line and
/// `CommandEvent::Stdout` read loop the earlier spike already
/// validated, now keeping the child alive instead of killing it right
/// after the probe. `broker_node_id` (`Profile.brokerNodeId`, absent for a
/// manually configured profile) is what the tailnet hostname is set from —
/// see `tailnet_hostname`. A cold start also captures the `NODE_KEY` line
/// the Go side prints once `tsnet.Up()` returns, so the JS caller
/// (`tailnetSidecar.ts`) can report it to the control plane. Joining a
/// running sidecar only happens for the same `target`: a different one
/// replaces it, and the replacement listens on a new local port.
#[tauri::command]
pub async fn tailnet_sidecar_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, TailnetSidecars>,
    profile_id: String,
    auth_key: String,
    control_url: String,
    target: String,
    broker_node_id: Option<String>,
) -> Result<TailnetUpResult, String> {
    let mut running = state.0.lock().await;
    if let Some(existing) = running.get(&profile_id) {
        if existing.target == target {
            return Ok(TailnetUpResult { addr: existing.addr.clone(), node_key: None });
        }
        // A caller with a newer grant says the relay lives somewhere else
        // now. The old child would keep dialing an address nobody answers
        // at, so it goes, and a fresh one joins with the new target (the
        // node identity lives in `-state-dir`, so this rejoin needs no
        // auth key). Its exit event finds a different pid in the map and
        // leaves the replacement alone.
        if let Some(stale) = running.remove(&profile_id) {
            eprintln!("[tailnet-sidecar] {profile_id}: target moved from {} to {target}, restarting", stale.target);
            if let Err(err) = stale.child.kill() {
                eprintln!("[tailnet-sidecar] {profile_id}: failed to kill the stale sidecar: {err}");
            }
        }
    }

    let state_dir = tailnet_state_dir(&app, &profile_id)?;
    let hostname_source = broker_node_id.as_deref().unwrap_or(&profile_id);
    let sidecar = app
        .shell()
        .sidecar("tailnet-sidecar")
        .map_err(|e| e.to_string())?
        .args([
            "tailnet-up",
            "-auth-key",
            &auth_key,
            "-control-url",
            &control_url,
            "-target",
            &target,
            "-listen",
            "127.0.0.1:0",
            "-state-dir",
            &state_dir.to_string_lossy(),
            "-hostname",
            &tailnet_hostname(hostname_source),
        ]);
    let (mut rx, child) = sidecar.spawn().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    job::adopt(child.pid());

    let mut listening: Option<String> = None;
    let mut node_key: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim();
                if let Some(addr) = line.strip_prefix("LISTENING ") {
                    listening = Some(addr.to_string());
                    break;
                }
                // Printed before LISTENING (Up() runs before Listen() on the
                // Go side) — captured, not broken on, so the loop still
                // exits on LISTENING as before.
                if let Some(key) = line.strip_prefix("NODE_KEY ") {
                    node_key = Some(key.to_string());
                }
            }
            // Everything the Go side has to say goes to stderr (tsnet join
            // progress on the way up, then every dial it makes into the
            // tailnet). Discarding it made a sidecar that came up but can't
            // reach its target indistinguishable from one that works — the
            // only observable difference is a chat socket that never opens.
            CommandEvent::Stderr(bytes) => log_sidecar(&profile_id, &bytes),
            CommandEvent::Error(err) => return Err(err),
            CommandEvent::Terminated(payload) => {
                return Err(format!("tailnet-sidecar exited before printing LISTENING: {payload:?}"));
            }
            _ => {}
        }
    }
    let Some(addr) = listening else {
        return Err("tailnet-sidecar stdout closed without a LISTENING line".to_string());
    };

    let pid = child.pid();
    running.insert(profile_id.clone(), Running { child, addr: addr.clone(), target });
    // The child outlives this command, so someone has to keep reading its
    // output — an unread channel would both lose the log above and, once
    // full, block the sidecar on its own writes.
    drop(running);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => log_sidecar(&profile_id, &bytes),
                CommandEvent::Terminated(payload) => {
                    eprintln!("[tailnet-sidecar] {profile_id} exited: {payload:?}");
                    // Without this, a sidecar that dies on its own (crash, the
                    // tailnet revoking this node mid-session, laptop
                    // sleep/wake killing the child) leaves its stale entry in
                    // the map — the next `tailnet_sidecar_start` for this
                    // profile would find it "already running" (the check at
                    // the top of this function) and hand back the dead
                    // `addr` forever, instead of spawning a fresh one. Only
                    // removes the entry if it still points at *this* child —
                    // `tailnet_sidecar_stop`/a fresh cold start racing this
                    // same event may have already replaced it with a live one.
                    if let Some(state) = app.try_state::<TailnetSidecars>() {
                        let mut running = state.0.lock().await;
                        if running.get(&profile_id).is_some_and(|entry| entry.child.pid() == pid) {
                            running.remove(&profile_id);
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(TailnetUpResult { addr, node_key })
}

fn log_sidecar(profile_id: &str, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim_end();
    if !line.is_empty() {
        eprintln!("[tailnet-sidecar] {profile_id}: {line}");
    }
}

/// Kills the `tailnet-up` child for `profile_id`, if any — a no-op if it
/// was never started or already stopped. The JS side (`tailnetSidecar.ts`)
/// only calls this once every tab using that profile has released it.
#[tauri::command]
pub async fn tailnet_sidecar_stop(
    state: tauri::State<'_, TailnetSidecars>,
    profile_id: String,
) -> Result<(), String> {
    let mut running = state.0.lock().await;
    if let Some(entry) = running.remove(&profile_id) {
        entry.child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kills every sidecar still running, for a quit that isn't going through
/// `tailnet_sidecar_stop` — that command only ever fires when the JS side
/// releases a profile, so closing the window (or quitting) with profiles
/// open leaves one `tailnet-up` behind each, still joined to the tenant's
/// tailnet and still holding the `-state-dir` a second node for the same
/// profile would fight over. Called from `lib.rs` on `RunEvent::Exit`; the
/// exits that run no code of ours at all are the Windows job object's job.
pub fn kill_all(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<TailnetSidecars>() else {
        return;
    };
    // Sync context (the run-event callback), so the map has to be drained
    // through the async runtime rather than awaited.
    let running: Vec<(String, Running)> =
        tauri::async_runtime::block_on(async { state.0.lock().await.drain().collect() });
    for (profile_id, entry) in running {
        if let Err(err) = entry.child.kill() {
            eprintln!("[tailnet-sidecar] {profile_id}: failed to kill on exit: {err}");
        }
    }
}

/// The only orphan cleanup on Windows that survives the exits `RunEvent::Exit`
/// never sees — a panic, an End Task, or the `Ctrl+C` that ends every
/// `tauri dev` session: a job object the children are assigned to, created
/// with `KILL_ON_JOB_CLOSE` so the kernel terminates them once the last
/// handle to it closes, which process teardown does unconditionally.
/// Windows-only because that's where a leaked child is worse than a leak: a
/// running `tailnet-sidecar.exe` can't be deleted, so the *next* build dies
/// in tauri-build's `remove_file(&dest).unwrap()` (lib.rs:80) with
/// `PermissionDenied`, having found the copy it wanted to replace locked by
/// a sidecar from a session that ended hours ago.
#[cfg(windows)]
mod job {
    use std::sync::OnceLock;

    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// Never closed on purpose: the handle's lifetime *is* the kill signal,
    /// so releasing it early would take the live sidecars down with it.
    struct Job(HANDLE);

    // A kernel handle is not bound to the thread that opened it.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<&'static Job> {
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(None, None).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of_val(&info) as u32,
            )
            .is_err()
            {
                let _ = CloseHandle(handle);
                return None;
            }
            Some(Job(handle))
        })
        .as_ref()
    }

    /// Best effort by design: a sidecar that can't be adopted still starts
    /// and works, it just goes back to being leakable on a hard exit.
    pub fn adopt(pid: u32) {
        let Some(job) = job() else { return };
        unsafe {
            let Ok(process) = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) else {
                eprintln!("[tailnet-sidecar] could not open pid {pid} to adopt it into the job");
                return;
            };
            if let Err(err) = AssignProcessToJobObject(job.0, process) {
                eprintln!("[tailnet-sidecar] could not adopt pid {pid} into the job: {err}");
            }
            let _ = CloseHandle(process);
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostname_matches_the_node_id_exactly() {
        // Byte-for-byte, not just "recognizable" — the control plane's own
        // cross-check does a plain string comparison, no prefix tolerance
        // (see this function's doc comment for the live bug this pins).
        let name = tailnet_hostname("77974f6e-e0ac-4d07-a0f0-0a8791c23e66");
        assert_eq!(name, "77974f6e-e0ac-4d07-a0f0-0a8791c23e66");
        assert!(name.len() <= 63);
        assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn hostname_survives_a_profile_id_that_is_not_a_uuid() {
        assert_eq!(tailnet_hostname("Trabalho Pessoal!"), "trabalho-pessoal-");
    }

    #[test]
    fn concurrent_signs_get_distinct_timestamps() {
        // The ENG-96 failure: two signs in the same millisecond. Every thread
        // reads the same wall clock, so only the reservation keeps them apart.
        let clock = std::sync::Arc::new(SignClock::default());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let clock = clock.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    clock.next(1_700_000_000_000)
                })
            })
            .collect();
        let mut stamps: Vec<i64> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        stamps.sort();
        stamps.dedup();
        assert_eq!(stamps.len(), 16);
        assert_eq!(stamps[0], 1_700_000_000_000);
    }

    #[test]
    fn sign_clock_follows_the_wall_clock_when_it_moves_ahead() {
        let clock = SignClock::default();
        assert_eq!(clock.next(100), 100);
        assert_eq!(clock.next(100), 101);
        assert_eq!(clock.next(500), 500);
        // A wall clock stepping back never repeats a stamp either.
        assert_eq!(clock.next(50), 501);
    }

    #[test]
    fn state_dir_segment_never_escapes_its_parent() {
        // A profile id is generated locally and never validated — it must not
        // be able to name a directory outside the app's own data dir.
        assert_eq!(sanitize_for_path("../../etc"), "------etc");
        assert!(!sanitize_for_path("../../etc").contains('.'));
    }
}
