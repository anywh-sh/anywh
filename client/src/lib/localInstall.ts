import {
  cancelLocalInstall,
  checkPrerequisites,
  getLocalInstallStatus,
  onInstallDone,
  onInstallLog,
  startLocalInstall,
  suggestAddresses,
  type AddressCandidate,
  type InstallDoneEvent,
  type InstallLogEvent,
  type InstallLogLine,
  type InstallProfileResult,
  type InstallRunStatus,
  type Prerequisites,
} from "@/lib/localRelay";
import { currentPlatform } from "@/lib/platform";
import { addProfile, type Profile } from "@/lib/profiles";
import { holdProfileSetup, resumeProfileSetup } from "@/lib/profileSetup";

/**
 * The in-app install of a relay on this machine, as a four-step machine:
 * prerequisites → profile and address → install → verify. Module-level, not
 * React state, for the same reason `profileSetup.ts` and `firstRun.ts` are:
 * the install is a child process that outlives any component, and a
 * StrictMode remount or a language switch re-rendering the tree must not
 * start it twice or forget it is running.
 *
 * Everything about the install itself comes from the installer's own
 * porcelain (`relay_setup.rs` relays it): which step is running, what it
 * learned, why it failed, and — once done — the profile's id, port and host
 * exactly as `add-profile.sh` wrote them. Nothing here re-derives any of
 * that; this module only decides what the screen shows and what the
 * buttons do.
 */

export type LocalStep = "prereqs" | "address" | "install" | "verify";

/** The one-line note under the wizard title, when there is one to show. */
export type LocalNote = "none" | "alreadyInstalled" | "interrupted" | "reattached";

/**
 * Everything that can stop the wizard, as stable codes. The installer's
 * own codes (`install.sh --porcelain`) pass through unchanged; the rest
 * are this side's. A code from a newer installer this build doesn't know
 * falls back to `unexpected` rather than a blank sentence.
 */
export type LocalFailureCode =
  | "node_missing"
  | "node_old"
  | "agent_missing"
  | "agent_not_logged_in"
  | "no_user_systemd"
  | "containerized"
  | "relay_running"
  | "relay_host_undetectable"
  | "download_failed"
  | "checksum_missing"
  | "checksum_mismatch"
  | "extract_failed"
  | "tarball_incomplete"
  | "service_failed"
  | "profile_failed"
  | "cancelled"
  | "interrupted"
  | "start_failed"
  | "unexpected"
  | "brew_missing"
  | "brew_install_failed"
  | "unsupported_arch";

/** What a failure box can offer. Which ones, per code, is `failureActions`. */
export type LocalFailureAction = "recheck" | "copyCommand" | "terminal" | "useDevMode" | "retry" | "resume" | "reinstall" | "back";

export interface LocalFailure {
  code: LocalFailureCode;
  /** The installer's own sentence, shown under the dictionary's one so the
   * detail (a path, a version, a checksum) isn't lost in translation. */
  detail: string;
  /** A command to copy, for the failures the human has to fix in a
   * terminal (logging the agent in). */
  command?: string;
}

/** The installer's steps the wizard draws as rows — `flags`, `target` and
 * `relay_host` are too quick and too internal to earn one. */
export type InstallRowKey = "prereqs" | "download" | "install" | "service" | "profile";
export const INSTALL_ROWS: InstallRowKey[] = ["prereqs", "download", "install", "service", "profile"];
/** macOS drives Homebrew instead of install.sh — no separate download step
 * to show (`brew install` does its own fetching), and the rest map to the
 * same steps app-install.sh's porcelain reports. */
export const MACOS_INSTALL_ROWS: InstallRowKey[] = ["prereqs", "install", "profile", "service"];

export type PhaseStatus = "idle" | "running" | "ok" | "failed";

export interface LocalInstallState {
  step: LocalStep;
  note: LocalNote;
  /** `dev` touches no systemd (the failure action for a session without
   * `systemd --user`); `prod` is the default. */
  mode: "prod" | "dev";
  prereqs: {
    status: PhaseStatus;
    result: Prerequisites | null;
    failure: LocalFailure | null;
    /** Seen, not blocking — the agent CLI wasn't there (or wasn't logged
     * in) when this was checked. Kept on the state for the whole wizard,
     * not just the step that found it, since the step collapses. */
    warning: LocalFailure | null;
  };
  candidates: AddressCandidate[];
  install: {
    runId: string | null;
    lines: InstallLogLine[];
    status: PhaseStatus;
    failure: LocalFailure | null;
    profile: InstallProfileResult | null;
    params: { label: string; host: string } | null;
  };
}

const KNOWN_CODES: ReadonlySet<string> = new Set<LocalFailureCode>([
  "node_missing",
  "node_old",
  "agent_missing",
  "agent_not_logged_in",
  "no_user_systemd",
  "containerized",
  "relay_running",
  "relay_host_undetectable",
  "download_failed",
  "checksum_missing",
  "checksum_mismatch",
  "extract_failed",
  "tarball_incomplete",
  "service_failed",
  "profile_failed",
  "cancelled",
  "interrupted",
  "start_failed",
  "unexpected",
  "brew_missing",
  "brew_install_failed",
  "unsupported_arch",
]);

export function toFailureCode(code: string): LocalFailureCode {
  return KNOWN_CODES.has(code) ? (code as LocalFailureCode) : "unexpected";
}

/**
 * What each failure can be followed by. Retryable network failures get
 * "try again"; a checksum mismatch deliberately doesn't — the same bytes
 * fail the same way, so the honest offers are the terminal and going back.
 * Anything the human has to do outside the app (log in, install node)
 * gets "check again" plus the command to copy when there is one.
 */
export function failureActions(code: LocalFailureCode): LocalFailureAction[] {
  switch (code) {
    case "node_missing":
    case "node_old":
    case "agent_missing":
      return ["recheck", "terminal"];
    case "agent_not_logged_in":
      return ["copyCommand", "recheck"];
    case "no_user_systemd":
      return ["useDevMode", "recheck"];
    case "containerized":
    case "relay_running":
      return ["back"];
    case "relay_host_undetectable":
      return ["back"];
    case "download_failed":
    case "extract_failed":
    case "service_failed":
    case "profile_failed":
    case "start_failed":
    case "unexpected":
      return ["retry", "terminal"];
    case "checksum_missing":
      return ["retry", "terminal"];
    case "checksum_mismatch":
    case "tarball_incomplete":
      return ["terminal", "back"];
    case "cancelled":
      return ["retry", "back"];
    case "interrupted":
      return ["resume", "reinstall"];
    case "brew_missing":
      return ["recheck", "terminal"];
    case "brew_install_failed":
      return ["retry", "terminal"];
    // Nothing to retry: the formula itself only ships arm64 today.
    case "unsupported_arch":
      return ["back"];
  }
}

function initialState(): LocalInstallState {
  return {
    step: "prereqs",
    note: "none",
    mode: "prod",
    prereqs: { status: "idle", result: null, failure: null, warning: null },
    candidates: [],
    install: { runId: null, lines: [], status: "idle", failure: null, profile: null, params: null },
  };
}

let state: LocalInstallState = initialState();
const listeners = new Set<() => void>();
/** Set while a run is in flight — see `holdProfileSetup`. Always released
 * through `releaseHold()`, which every exit from the install step calls. */
let releaseHoldFn: (() => void) | null = null;
let listenersAttached = false;
/** Guards a prerequisites check that resolves after the wizard moved on
 * (a reset, a second check started by "check again"). */
let prereqsGeneration = 0;

function publish(next: LocalInstallState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getLocalInstallState(): LocalInstallState {
  return state;
}

export function subscribeLocalInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function releaseHold(): void {
  if (releaseHoldFn) {
    const release = releaseHoldFn;
    releaseHoldFn = null;
    release();
  }
}

/** Enters the wizard at the first step and starts checking. `note` is what
 * the recognition step learned (a relay already here, an interrupted run). */
export function beginLocalInstall(note: LocalNote = "none"): void {
  releaseHold();
  publish({ ...initialState(), note });
  void runPrereqs();
}

/** The first step, and the one "check again" re-runs. Every failing
 * condition is checked in the order a person would fix them: the runtime,
 * the agent, then the service manager — the last only when a service is
 * actually going to be registered. */
export async function runPrereqs(): Promise<void> {
  const generation = ++prereqsGeneration;
  publish({ ...state, step: "prereqs", prereqs: { status: "running", result: null, failure: null, warning: null } });
  let result: Prerequisites;
  try {
    result = await checkPrerequisites();
  } catch (err) {
    if (generation !== prereqsGeneration) return;
    publish({
      ...state,
      prereqs: { status: "failed", result: null, failure: { code: "unexpected", detail: err instanceof Error ? err.message : String(err) }, warning: null },
    });
    return;
  }
  if (generation !== prereqsGeneration) return;

  const warning = evaluateAgentReadiness(result);
  const failure = evaluatePrerequisites(result, state.mode);
  if (failure) {
    publish({ ...state, prereqs: { status: "failed", result, failure, warning } });
    return;
  }
  // Best effort: the address step still works with an empty list (the
  // human can type one), it just has nothing to recommend.
  const candidates = await suggestAddresses().catch(() => [] as AddressCandidate[]);
  if (generation !== prereqsGeneration) return;
  publish({ ...state, step: "address", prereqs: { status: "ok", result, failure: null, warning }, candidates });
}

/**
 * `platform` defaults to `currentPlatform()` so call sites outside Tauri
 * (tests) get the Linux checklist without saying so. macOS drives Homebrew
 * instead of a preinstalled Node — it checks `brewPath` where the Linux
 * branch checks `nodePath`/`nodeOk`, and never asks about `systemd --user`
 * or `activeUnits`, both meaningless off that platform (relay_setup.rs
 * only ever populates them on Linux).
 */
export function evaluatePrerequisites(result: Prerequisites, mode: "prod" | "dev", platform: string | null = currentPlatform()): LocalFailure | null {
  if (platform === "macos") {
    if (!result.brewPath) return { code: "brew_missing", detail: "" };
    return null;
  }
  if (!result.nodePath) return { code: "node_missing", detail: "" };
  if (!result.nodeOk) return { code: "node_old", detail: result.nodeVersion ?? "" };
  if (result.activeUnits.length > 0) return { code: "relay_running", detail: result.activeUnits.join(", ") };
  if (mode === "prod" && !result.systemdUser) return { code: "no_user_systemd", detail: "" };
  return null;
}

/**
 * The agent CLI, as a remark rather than a gate — the one prerequisite
 * this wizard deliberately does not block on.
 *
 * Nothing about installing a relay needs an agent CLI to exist yet: the
 * relay installs, starts, and serves without one, and it looks the binary
 * up when a turn actually spawns it (`resolveAgentBin`, relay side), not
 * when it was installed. So a CLI installed or logged into ten minutes
 * from now simply works, with nothing to re-run here — while refusing to
 * install until one is present strands a user on a screen whose only
 * instruction is to go do something else first.
 *
 * It also stops making sense the moment there is more than one agent CLI
 * worth driving: "the agent is missing" is a claim about one specific
 * binary that happened to be checked, and the relay's own AGENT_BIN is
 * what decides which.
 *
 * Still surfaced, because a relay whose first conversation is going to
 * fail is worth saying out loud while there's a terminal open and the
 * command is right there to copy.
 */
export function evaluateAgentReadiness(result: Prerequisites): LocalFailure | null {
  if (!result.agentPath) return { code: "agent_missing", detail: result.agentBin };
  if (result.agentLoggedIn !== true) {
    return { code: "agent_not_logged_in", detail: result.agentError ?? "", command: `${result.agentBin} login` };
  }
  return null;
}

/** The "use dev mode" action: no service gets registered, the relay is
 * started by hand — the sandbox a developer's own machine, which already
 * runs real profiles, should stay in. Re-checks, since the service-manager
 * condition no longer applies. */
export function useDevMode(): void {
  publish({ ...state, mode: "dev" });
  void runPrereqs();
}

async function ensureListeners(): Promise<void> {
  if (listenersAttached) return;
  listenersAttached = true;
  await onInstallLog(handleLogEvent);
  await onInstallDone(handleDoneEvent);
}

function handleLogEvent(event: InstallLogEvent): void {
  if (event.runId !== state.install.runId || state.install.status !== "running") return;
  const lines = state.install.lines;
  const last = lines.length > 0 ? lines[lines.length - 1].seq : 0;
  if (event.seq !== last + 1) {
    // A gap — an event was emitted with no listener mounted, or arrived
    // out of order. The status on disk is the truth; read it whole.
    void hydrate();
    return;
  }
  publish({
    ...state,
    install: { ...state.install, lines: [...state.install.lines, { seq: event.seq, line: event.line, event: event.event }] },
  });
}

function handleDoneEvent(event: InstallDoneEvent): void {
  if (event.runId !== state.install.runId) return;
  void hydrate().then(() => settle(event.ok, event.profile, event.failure));
}

function settle(ok: boolean, profile: InstallProfileResult | null, failure: { code: string; message: string } | null): void {
  releaseHold();
  if (ok && profile) {
    publish({ ...state, step: "verify", install: { ...state.install, status: "ok", profile, failure: null } });
    adoptInstalledProfile(profile);
    return;
  }
  const code: LocalFailureCode = failure ? toFailureCode(failure.code) : state.install.lines.length > 0 ? "cancelled" : "unexpected";
  publish({
    ...state,
    install: { ...state.install, status: "failed", failure: { code, detail: failure?.message ?? "" } },
  });
}

/** Hands the freshly provisioned profile to the same verification every
 * other path uses: saved as unverified, `resumeProfileSetup` dials it and
 * the setup dialog shows the outcome. The id, port and host are the
 * installer's — the one place they are decided. */
function adoptInstalledProfile(result: InstallProfileResult): void {
  const profile: Profile = {
    id: result.id,
    label: state.install.params?.label.trim() || result.id,
    host: result.host ?? "127.0.0.1",
    relayPort: result.port ?? 8765,
    localRelay: true,
    unverified: true,
  };
  addProfile(profile);
  resumeProfileSetup(profile);
}

async function hydrate(): Promise<void> {
  const status = await getLocalInstallStatus();
  if (!status || status.runId !== state.install.runId) return;
  publish({ ...state, install: { ...state.install, lines: status.lines } });
}

/** Step 2's confirm: a label (blank means the installer's default id) and
 * the address other devices will reach this machine on. */
export function confirmAddress(params: { label: string; host: string }): void {
  publish({ ...state, step: "install", install: { ...initialState().install, params } });
  void startInstall();
}

async function startInstall(): Promise<void> {
  const params = state.install.params;
  if (!params) return;
  // A link arriving while the install owns the screen waits, visibly,
  // instead of opening the setup dialog over the installer's log.
  releaseHold();
  releaseHoldFn = holdProfileSetup();
  publish({ ...state, install: { ...state.install, status: "running", failure: null, lines: [], profile: null } });
  try {
    await ensureListeners();
    const info = await startLocalInstall({
      profileLabel: params.label.trim() || undefined,
      profileId: params.label.trim() ? undefined : "default",
      relayHost: params.host,
      mode: state.mode,
    });
    publish({ ...state, install: { ...state.install, runId: info.runId } });
    await hydrate();
    // The run may have finished between start and hydrate (a fast failure).
    const status = await getLocalInstallStatus();
    if (status && status.runId === info.runId && !status.alive) settle(status.ok, status.profile, status.failure);
  } catch (err) {
    releaseHold();
    publish({
      ...state,
      install: { ...state.install, status: "failed", failure: { code: "start_failed", detail: err instanceof Error ? err.message : String(err) } },
    });
  }
}

/** "Try again" / "resume": the same address and label, one more run. The
 * installer's own `--resume` is what makes it pick up where it stopped. */
export function retryInstall(): void {
  if (!state.install.params) return;
  void startInstall();
}

/** "Start over": the same as retry from the installer's point of view —
 * `install.sh` swaps the whole tree every run — but the wizard forgets the
 * previous run's log first. */
export function reinstall(): void {
  publish({ ...state, install: { ...state.install, lines: [], failure: null, runId: null } });
  void startInstall();
}

export async function cancelInstall(): Promise<void> {
  try {
    await cancelLocalInstall();
  } catch {
    // The done event (or its absence) is what the screen goes by.
  }
}

/**
 * Recognition found a run from before: alive (the app was closed on it)
 * or dead without finishing (the machine or the app died). Either way the
 * wizard opens on the install step with the log so far.
 */
export async function attachPreviousRun(status: InstallRunStatus): Promise<void> {
  releaseHold();
  const params = {
    label: status.params.profileLabel ?? status.params.profileId ?? "",
    host: status.params.relayHost,
  };
  const base: LocalInstallState = {
    ...initialState(),
    step: "install",
    note: status.alive ? "reattached" : "interrupted",
    mode: status.params.mode === "dev" ? "dev" : "prod",
    prereqs: { status: "ok", result: null, failure: null, warning: null },
    install: { runId: status.runId, lines: status.lines, status: "running", failure: null, profile: null, params },
  };
  publish(base);
  if (status.alive) {
    releaseHoldFn = holdProfileSetup();
    await ensureListeners();
    return;
  }
  if (status.ok && status.profile) {
    settle(true, status.profile, null);
    return;
  }
  publish({
    ...state,
    install: {
      ...state.install,
      status: "failed",
      failure: status.failure
        ? { code: toFailureCode(status.failure.code), detail: status.failure.message }
        : { code: status.cancelled ? "cancelled" : "interrupted", detail: "" },
    },
  });
}

export function __resetLocalInstallForTests(): void {
  releaseHold();
  prereqsGeneration++;
  state = initialState();
  listenersAttached = false;
}
