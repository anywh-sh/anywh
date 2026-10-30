import {
  cancelLocalInstall,
  checkPrerequisites,
  getLocalInstallStatus,
  onInstallDone,
  onInstallLog,
  startLocalInstall,
  type InstallDoneEvent,
  type InstallFailure,
  type InstallLogEvent,
  type InstallLogLine,
  type InstallProfileResult,
  type InstallRunStatus,
  type Prerequisites,
} from "@/lib/install/localRelay";
import { currentPlatform } from "@/lib/platform/platform";
import { addProfile, findProfile, type Profile } from "@/lib/profiles/profiles";
import {
  getProfileSetupState,
  holdProfileSetup,
  resumeProfileSetup,
  retryProfileSetup,
  subscribeProfileSetup,
} from "@/lib/profiles/profileSetup";

/**
 * The in-app install of a relay on this machine, as three steps: check this
 * machine → install → start (the service comes up and the new profile
 * answers). Module-level, not React state, for the same reason
 * `profileSetup.ts` and `firstRun.ts` are: the install is a child process
 * that outlives any component, and a StrictMode remount or a language
 * switch re-rendering the tree must not start it twice or forget it is
 * running.
 *
 * Everything about the install itself comes from the installer's own
 * porcelain (`relay_setup.rs` relays it): which step is running, what it
 * learned, why it failed, and — once done — the profile's id, port and host
 * exactly as `add-profile.sh` wrote them. The three steps are only a
 * grouping of the porcelain's steps made here (`STEP_OF_PORCELAIN`); the
 * porcelain itself is a contract shared with `install.sh` and the Homebrew
 * tap and never changes for the screen's sake.
 *
 * The easy path asks nothing: the profile is `default`, labelled in the
 * reader's language, on `127.0.0.1`. Other values only ever arrive from the
 * advanced options, through the same `beginLocalInstall`.
 */

export type LocalStep = "check" | "install" | "start";
export const LOCAL_STEPS: LocalStep[] = ["check", "install", "start"];

/** The one-line note under the title, when there is one to show. */
export type LocalNote = "none" | "alreadyInstalled" | "resuming" | "reattached";

/**
 * Everything that can stop the install, as stable codes. The installer's
 * own codes (`install-relay.sh --porcelain`) pass through unchanged; the rest
 * are this side's. A code from a newer installer this build doesn't know
 * falls back to `unexpected` rather than a blank sentence.
 */
export type LocalFailureCode =
  | "node_missing"
  | "node_old"
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

/** Every way the preparing screen can stop: the installer's, plus a relay
 * that is installed (or adopted) but never answers. Typed as a superset so
 * no code can ever reach the screen without copy. */
export type PreparingFailureCode = LocalFailureCode | "unresponsive";

/** What a failure can offer. Which ones, per code, is `failureActions`. */
export type LocalFailureAction = "recheck" | "retry" | "terminal" | "back" | "otherMachine";

export interface LocalFailure {
  code: PreparingFailureCode;
  /** The installer's own sentence, shown under the dictionary's one so the
   * detail (a path, a version, a checksum) isn't lost in translation. */
  detail: string;
}

export type PhaseStatus = "idle" | "running" | "ok" | "failed";

/** What the installer is asked for. `profileId: null` lets the installer
 * slug the id out of the label (a name typed in the advanced options);
 * the easy path always asks for `default`. */
export interface LocalInstallParams {
  label: string;
  host: string;
  profileId: string | null;
}

export interface LocalInstallState {
  note: LocalNote;
  /** `dev` touches no systemd (chosen in the advanced options, never from
   * a failure); `prod` is the default. */
  mode: "prod" | "dev";
  params: LocalInstallParams | null;
  prereqs: {
    status: PhaseStatus;
    result: Prerequisites | null;
    failure: LocalFailure | null;
  };
  install: {
    runId: string | null;
    lines: InstallLogLine[];
    status: PhaseStatus;
    failure: LocalFailure | null;
    /** The porcelain step the failure was reported on, when it said. */
    failedStep: string | null;
    profile: InstallProfileResult | null;
  };
  /** The new profile answering `GET /sessions`, through the same
   * `profileSetup` verification every other path uses. */
  verify: {
    status: PhaseStatus;
    profileId: string | null;
    failure: LocalFailure | null;
  };
}

const KNOWN_CODES: ReadonlySet<string> = new Set<LocalFailureCode>([
  "node_missing",
  "node_old",
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
 * What each failure can be followed by. Retryable failures get "try
 * again"; a checksum mismatch deliberately doesn't — the same bytes fail
 * the same way, so the honest offers are the terminal and going back.
 * Anything the human has to fix outside the app gets "check again". Dev
 * mode is never offered here: it lives in the advanced options, where
 * choosing it is deliberate.
 */
export function failureActions(code: PreparingFailureCode): LocalFailureAction[] {
  switch (code) {
    case "node_missing":
    case "node_old":
      return ["recheck", "terminal"];
    case "brew_missing":
    case "brew_install_failed":
    case "download_failed":
    case "checksum_missing":
    case "extract_failed":
    case "service_failed":
    case "profile_failed":
    case "start_failed":
    case "unexpected":
    case "unresponsive":
      return ["retry", "terminal"];
    case "checksum_mismatch":
    case "tarball_incomplete":
      return ["terminal", "back"];
    case "no_user_systemd":
    case "containerized":
      return ["terminal"];
    case "relay_running":
      return ["terminal", "back"];
    case "relay_host_undetectable":
      return ["back"];
    // Nothing to retry: the formula itself only ships arm64 today.
    case "unsupported_arch":
      return ["otherMachine", "back"];
    // Resumes on its own (`attachPreviousRun`); these only show if the
    // resume itself could not even start.
    case "interrupted":
      return ["retry", "terminal"];
    // The screen goes back to the welcome on its own.
    case "cancelled":
      return ["back"];
  }
}

/**
 * Which of the three steps each porcelain step belongs to. Linux
 * (`install-relay.sh`) reports `relay_host`/`download`/`install` and then
 * `service`/`profile`; macOS (`app-install.sh`) reports `install` and then
 * `profile`/`service` — the same grouping covers both orders.
 */
const STEP_OF_PORCELAIN: Readonly<Record<string, LocalStep>> = {
  flags: "check",
  target: "check",
  prereqs: "check",
  relay_host: "install",
  download: "install",
  install: "install",
  service: "start",
  profile: "start",
};

export type StepStatus = "pending" | "running" | "done" | "failed";

export interface PreparingStep {
  key: LocalStep;
  status: StepStatus;
  /** The installer's last line while this step is the one running — the
   * live line under it. */
  liveLine: string | null;
}

/** The furthest of the three steps the porcelain has reached, or null
 * before its first step line. */
function reachedStep(lines: InstallLogLine[]): LocalStep | null {
  let reached: LocalStep | null = null;
  for (const line of lines) {
    const event = line.event;
    if (!event || event.kind === "profile") continue;
    const step = STEP_OF_PORCELAIN[event.step];
    if (step && (reached === null || LOCAL_STEPS.indexOf(step) > LOCAL_STEPS.indexOf(reached))) reached = step;
  }
  return reached;
}

/** The last human line of the run — what "live" shows. Porcelain lines
 * are for this module, not for the reader; blanks say nothing. */
function lastLine(lines: InstallLogLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].line.trim();
    if (text && !lines[i].event) return text;
  }
  return null;
}

/** Where the run stands: the step it is in, and whether that step failed. */
function activeStep(state: LocalInstallState): { step: LocalStep; failed: boolean } | null {
  const { prereqs, install, verify } = state;
  if (prereqs.status === "running") return { step: "check", failed: false };
  if (prereqs.status === "failed") return { step: "check", failed: true };
  if (install.status === "running" || install.status === "failed") {
    const failedOn = install.failedStep ? STEP_OF_PORCELAIN[install.failedStep] : undefined;
    const step = failedOn ?? reachedStep(install.lines) ?? "check";
    return { step, failed: install.status === "failed" };
  }
  if (install.status === "ok") {
    if (verify.status === "ok") return null;
    return { step: "start", failed: verify.status === "failed" };
  }
  return null;
}

/** The three rows the screen draws, derived from the state alone. */
export function preparingSteps(state: LocalInstallState): PreparingStep[] {
  const done = state.verify.status === "ok";
  const active = activeStep(state);
  const activeIndex = active ? LOCAL_STEPS.indexOf(active.step) : -1;
  const live = state.install.status === "running" ? lastLine(state.install.lines) : null;
  return LOCAL_STEPS.map((key, index) => {
    let status: StepStatus = "pending";
    if (done || index < activeIndex) status = "done";
    else if (index === activeIndex) status = active?.failed ? "failed" : "running";
    return { key, status, liveLine: status === "running" ? live : null };
  });
}

/** The one failure on screen, whichever phase produced it. */
export function preparingFailure(state: LocalInstallState): LocalFailure | null {
  return state.prereqs.failure ?? state.install.failure ?? state.verify.failure;
}

/** The whole run at a glance: still going, stopped, or the profile is up
 * and answering (the screen moves on). */
export function preparingOutcome(state: LocalInstallState): "idle" | "running" | "failed" | "ready" {
  if (state.verify.status === "ok") return "ready";
  if (preparingFailure(state)) return "failed";
  if (state.prereqs.status === "idle" && state.install.status === "idle") return "idle";
  return "running";
}

function initialState(): LocalInstallState {
  return {
    note: "none",
    mode: "prod",
    params: null,
    prereqs: { status: "idle", result: null, failure: null },
    install: { runId: null, lines: [], status: "idle", failure: null, failedStep: null, profile: null },
    verify: { status: "idle", profileId: null, failure: null },
  };
}

let state: LocalInstallState = initialState();
const listeners = new Set<() => void>();
/** Set while a run is in flight — see `holdProfileSetup`. Always released
 * through `releaseHold()`, which every exit from the install calls. */
let releaseHoldFn: (() => void) | null = null;
let listenersAttached = false;
/** Guards a prerequisites check that resolves after the run moved on (a
 * reset, a second check started by "check again"). */
let prereqsGeneration = 0;
let unsubscribeSetup: (() => void) | null = null;

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

function stopWatchingSetup(): void {
  unsubscribeSetup?.();
  unsubscribeSetup = null;
}

export interface BeginLocalInstallOptions {
  /** The profile's label, already in the reader's language. */
  label: string;
  /** Defaults to loopback — the easy path never asks. */
  host?: string;
  /** Defaults to `default`; `null` lets the installer slug the label. */
  profileId?: string | null;
  mode?: "prod" | "dev";
  note?: LocalNote;
}

/** Starts from the first step: check this machine, then install with no
 * further question. */
export function beginLocalInstall(options: BeginLocalInstallOptions): void {
  releaseHold();
  stopWatchingSetup();
  publish({
    ...initialState(),
    note: options.note ?? "none",
    mode: options.mode ?? "prod",
    params: {
      label: options.label,
      host: options.host ?? "127.0.0.1",
      profileId: options.profileId === undefined ? "default" : options.profileId,
    },
  });
  void runPrereqs();
}

/** The check step's own half, and what "check again" re-runs: a missing
 * runtime is said before the installer is ever spawned. Passing goes
 * straight on to the install. */
export async function runPrereqs(): Promise<void> {
  const generation = ++prereqsGeneration;
  publish({ ...state, prereqs: { status: "running", result: null, failure: null } });
  let result: Prerequisites;
  try {
    result = await checkPrerequisites();
  } catch (err) {
    if (generation !== prereqsGeneration) return;
    publish({
      ...state,
      prereqs: { status: "failed", result: null, failure: { code: "unexpected", detail: err instanceof Error ? err.message : String(err) } },
    });
    return;
  }
  if (generation !== prereqsGeneration) return;

  const failure = evaluatePrerequisites(result, state.mode);
  if (failure) {
    publish({ ...state, prereqs: { status: "failed", result, failure } });
    return;
  }
  publish({ ...state, prereqs: { status: "ok", result, failure: null } });
  void startInstall();
}

/**
 * `platform` defaults to `currentPlatform()` so call sites outside Tauri
 * (tests) get the Linux checklist without saying so. macOS drives Homebrew
 * instead of a preinstalled Node — it checks `brewPath` where the Linux
 * branch checks `nodePath`/`nodeOk`, and never asks about `systemd --user`
 * or `activeUnits`, both meaningless off that platform (relay_setup.rs
 * only ever populates them on Linux).
 *
 * The agent CLI is not a prerequisite: the relay installs, starts and
 * serves without one and resolves the binary when a turn spawns it. Which
 * agents are here is the relay's to say, on the agents screen.
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

function settle(ok: boolean, profile: InstallProfileResult | null, failure: InstallFailure | null): void {
  if (ok && profile) {
    publish({ ...state, install: { ...state.install, status: "ok", profile, failure: null, failedStep: null } });
    // Verification takes the setup queue before the hold lifts: a link that
    // waited on the install runs after this profile, not instead of it.
    verifyInstalledProfile(profile);
    releaseHold();
    return;
  }
  releaseHold();
  const code: LocalFailureCode = failure ? toFailureCode(failure.code) : state.install.lines.length > 0 ? "cancelled" : "unexpected";
  publish({
    ...state,
    install: { ...state.install, status: "failed", failure: { code, detail: failure?.message ?? "" }, failedStep: failure?.step ?? null },
  });
}

/** Hands the freshly provisioned profile to the same verification every
 * other path uses — saved as unverified, `resumeProfileSetup` dials it —
 * and follows that verification as the last part of the start step. The
 * id, port and host are the installer's, the one place they are decided. */
function verifyInstalledProfile(result: InstallProfileResult): void {
  const profile: Profile = {
    id: result.id,
    label: state.params?.label.trim() || result.id,
    host: result.host ?? "127.0.0.1",
    relayPort: result.port ?? 8765,
    localRelay: true,
    unverified: true,
  };
  addProfile(profile);
  publish({ ...state, verify: { status: "running", profileId: profile.id, failure: null } });
  watchSetup();
  resumeProfileSetup(profile);
}

/** Mirrors `profileSetup`'s outcome for the installed profile onto the
 * start step: ready is done, a failed connect or verify is a relay that
 * was installed but doesn't answer. */
function watchSetup(): void {
  stopWatchingSetup();
  const sync = (): void => {
    const setup = getProfileSetupState().state;
    const id = state.verify.profileId;
    if (!setup || !id || !("profile" in setup) || setup.profile.id !== id) return;
    if (setup.status === "ready") {
      stopWatchingSetup();
      publish({ ...state, verify: { ...state.verify, status: "ok", failure: null } });
    } else if (setup.status === "failed") {
      publish({ ...state, verify: { ...state.verify, status: "failed", failure: { code: "unresponsive", detail: "" } } });
    } else if (state.verify.status !== "running") {
      publish({ ...state, verify: { ...state.verify, status: "running", failure: null } });
    }
  };
  unsubscribeSetup = subscribeProfileSetup(sync);
  sync();
}

async function hydrate(): Promise<void> {
  const status = await getLocalInstallStatus();
  if (!status || status.runId !== state.install.runId) return;
  publish({ ...state, install: { ...state.install, lines: status.lines } });
}

async function startInstall(): Promise<void> {
  const params = state.params;
  if (!params) return;
  // A link arriving while the install owns the screen waits, visibly,
  // instead of opening the setup dialog over the installer's log.
  releaseHold();
  releaseHoldFn = holdProfileSetup();
  publish({ ...state, install: { ...initialState().install, status: "running" } });
  try {
    await ensureListeners();
    const info = await startLocalInstall({
      profileLabel: params.label.trim() || undefined,
      profileId: params.profileId ?? undefined,
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
      install: { ...state.install, status: "failed", failure: { code: "start_failed", detail: err instanceof Error ? err.message : String(err) }, failedStep: null },
    });
  }
}

/** "Try again": picks up from where it stopped. A failed check re-checks;
 * a failed install runs the installer again with the same parameters —
 * its own `--resume` is what makes it continue rather than redo; a relay
 * that doesn't answer is dialled again, nothing reinstalled. */
export function retryLocalInstall(): void {
  if (state.verify.status === "failed") {
    publish({ ...state, verify: { ...state.verify, status: "running", failure: null } });
    // The failed request may still be the one on `profileSetup`'s screen,
    // or may have been dismissed since; either way only the dialling is
    // repeated, never the install.
    const setup = getProfileSetupState().state;
    const profile = state.verify.profileId ? findProfile(state.verify.profileId) : undefined;
    if (setup?.status === "failed" && setup.stage !== "claim" && setup.profile.id === state.verify.profileId) retryProfileSetup();
    else if (profile) resumeProfileSetup(profile);
    return;
  }
  if (state.prereqs.status !== "ok") {
    void runPrereqs();
    return;
  }
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
 * A run from before: alive (the app was closed on it) — follow it; dead
 * without finishing (the machine or the app died) — resume it on its own,
 * with no question; dead with a reason — show the reason.
 */
export async function attachPreviousRun(status: InstallRunStatus): Promise<void> {
  releaseHold();
  stopWatchingSetup();
  const params: LocalInstallParams = {
    label: status.params.profileLabel ?? status.params.profileId ?? "",
    host: status.params.relayHost,
    profileId: status.params.profileId,
  };
  const interrupted = !status.alive && !status.ok && !status.failure && !status.cancelled;
  publish({
    ...initialState(),
    note: status.alive ? "reattached" : interrupted ? "resuming" : "none",
    mode: status.params.mode === "dev" ? "dev" : "prod",
    params,
    prereqs: { status: "ok", result: null, failure: null },
    install: { runId: status.runId, lines: status.lines, status: "running", failure: null, failedStep: null, profile: null },
  });
  if (status.alive) {
    releaseHoldFn = holdProfileSetup();
    await ensureListeners();
    return;
  }
  if (status.ok && status.profile) {
    settle(true, status.profile, null);
    return;
  }
  if (interrupted) {
    void startInstall();
    return;
  }
  settle(false, null, status.failure ?? { step: "", code: "cancelled", message: "" });
}

export function __resetLocalInstallForTests(): void {
  releaseHold();
  stopWatchingSetup();
  prereqsGeneration++;
  state = initialState();
  listenersAttached = false;
}
