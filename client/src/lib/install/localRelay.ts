import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { currentPlatform } from "@/lib/platform/platform";
import { inTauri } from "@/lib/platform/tauri";

/**
 * Thin binding over the `relay_setup_*` commands (src-tauri/src/relay_setup.rs)
 * — the in-app install of a relay on *this* machine. Same shape as
 * `tailnetSidecar.ts`: every call is guarded by `inTauri()`, and outside
 * Tauri (a browser `vite dev`, the unit tier) the probe answers "nothing
 * here" and the rest rejects, so nothing above has to know where it runs.
 * The types mirror the Rust structs field for field (camelCase on the wire).
 */

export interface ProbeProfile {
  id: string;
  label: string | null;
  port: number | null;
  host: string | null;
  homeOverride: string | null;
  registered: boolean;
}

export interface LocalRelayProbe {
  platform: "linux" | "macos" | "windows" | "other";
  supported: boolean;
  containerized: "flatpak" | "snap" | null;
  installDir: string;
  installed: boolean;
  installedVersion: string | null;
  unitInstalled: boolean;
  envDir: string;
  profiles: ProbeProfile[];
  orphanDefault: boolean;
  previousRun: InstallRunStatus | null;
}

export interface Prerequisites {
  nodePath: string | null;
  nodeVersion: string | null;
  nodeOk: boolean;
  /** Only meaningful on macOS — the Homebrew formula pulls its own Node via
   * `depends_on "node"`, so `nodePath`/`nodeOk` answer a question that
   * platform doesn't ask. */
  brewPath: string | null;
  /** macOS: this app ships its own relay (the Apple Silicon release), so
   * nothing is installed and Homebrew is not needed. */
  bundledRelay: boolean;
  systemdUser: boolean;
  xdgRuntimeDir: boolean;
  activeUnits: string[];
}

export type AddressKind = "tailnet" | "lan" | "public" | "loopback";

export interface AddressCandidate {
  address: string;
  kind: AddressKind;
  interface: string;
  recommended: boolean;
}

export type PorcelainEvent =
  | { kind: "step"; step: string }
  | { kind: "done"; step: string; fields: Record<string, string> }
  | { kind: "fail"; step: string; code: string; message: string }
  | { kind: "profile"; fields: Record<string, string> };

export interface InstallLogLine {
  seq: number;
  line: string;
  event: PorcelainEvent | null;
}

export interface InstallProfileResult {
  id: string;
  port: number | null;
  host: string | null;
  mode: string | null;
}

export interface InstallFailure {
  step: string;
  code: string;
  message: string;
}

export interface InstallStartParams {
  profileId?: string;
  profileLabel?: string;
  relayHost: string;
  profileHome?: string;
  mode?: "dev" | "prod";
}

export interface InstallRunStatus {
  runId: string;
  pid: number;
  alive: boolean;
  cancelled: boolean;
  exitCode: number | null;
  startedAt: number;
  params: {
    profileId: string | null;
    profileLabel: string | null;
    relayHost: string;
    profileHome: string | null;
    mode: string | null;
  };
  lines: InstallLogLine[];
  ok: boolean;
  profile: InstallProfileResult | null;
  failure: InstallFailure | null;
}

export interface InstallLogEvent {
  runId: string;
  seq: number;
  line: string;
  event: PorcelainEvent | null;
}

export interface InstallDoneEvent {
  runId: string;
  exitCode: number | null;
  ok: boolean;
  profile: InstallProfileResult | null;
  failure: InstallFailure | null;
}

export interface InstallRunInfo {
  runId: string;
  logPath: string;
  started: boolean;
}

/** The in-app install exists on Linux (systemd) and macOS (Homebrew); the
 * probe says whether *this* machine can (not a Flatpak/Snap sandbox on
 * Linux). Outside Tauri, or on Windows, there is no in-app path at all —
 * `ManualInstructions` is the fallback everywhere else. */
export function localInstallPossible(): boolean {
  const platform = currentPlatform();
  return inTauri() && (platform === "linux" || platform === "macos");
}

const NOT_IN_TAURI = "the in-app relay install needs the desktop app";

export async function probeLocalRelay(): Promise<LocalRelayProbe | null> {
  if (!inTauri()) return null;
  return invoke<LocalRelayProbe>("relay_setup_probe");
}

export function checkPrerequisites(): Promise<Prerequisites> {
  if (!inTauri()) return Promise.reject(new Error(NOT_IN_TAURI));
  return invoke<Prerequisites>("relay_setup_prerequisites");
}

export function suggestAddresses(): Promise<AddressCandidate[]> {
  if (!inTauri()) return Promise.reject(new Error(NOT_IN_TAURI));
  return invoke<AddressCandidate[]>("relay_setup_suggest_address");
}

export function startLocalInstall(params: InstallStartParams): Promise<InstallRunInfo> {
  if (!inTauri()) return Promise.reject(new Error(NOT_IN_TAURI));
  return invoke<InstallRunInfo>("relay_setup_start", { params });
}

/** Why the app's own Homebrew update of the relay did not happen
 * (`relay_brew_upgrade`): a code to pick the person's sentence by, and
 * Homebrew's own words when it ran and failed. */
export type BrewUpgradeErrorCode =
  /** Not the macOS desktop app. */
  | "unsupported_platform"
  /** The relay names another machine than this one (a loopback address
   * that is an SSH tunnel to another Mac): nothing was touched here. */
  | "other_machine"
  /** The app is already upgrading the relay, or installing one. */
  | "busy"
  /** The Homebrew tap has no newer relay than the one installed yet;
   * nothing was upgraded or restarted. */
  | "nothing_newer"
  /** Homebrew ran for too long, and was stopped. */
  | "timeout"
  /** Homebrew could not be started at all. */
  | "spawn_failed"
  /** Homebrew ran and failed (`detail` is its own words). */
  | "failed";

export class BrewUpgradeError extends Error {
  constructor(
    readonly code: BrewUpgradeErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

function toBrewUpgradeError(raw: unknown): BrewUpgradeError {
  if (typeof raw === "object" && raw !== null && typeof (raw as { code?: unknown }).code === "string") {
    const { code, detail } = raw as { code: BrewUpgradeErrorCode; detail?: unknown };
    return new BrewUpgradeError(code, typeof detail === "string" && detail !== "" ? detail : undefined);
  }
  return new BrewUpgradeError("failed", raw instanceof Error ? raw.message : String(raw));
}

/** Whether this desktop app ships its own relay (the Apple Silicon macOS
 * release). False outside Tauri, and in a dev or Intel build. */
export function appShipsRelay(): Promise<boolean> {
  if (!inTauri()) return Promise.resolve(false);
  return invoke<boolean>("relay_bundled").catch(() => false);
}

/** Upgrades the Homebrew relay on this Mac and restarts its service
 * (`brew upgrade anywh-relay` + `brew services restart`) — or, when the app
 * ships its own relay (`appShipsRelay`), moves the profile to it and
 * uninstalls the formula, once. Rejects with a
 * `BrewUpgradeError`. `relayHostname` is the host name the relay gave
 * (`/host-info`): the native side refuses (`other_machine`) when it is not
 * this machine's. */
export function upgradeBrewRelay(relayHostname?: string): Promise<void> {
  if (!inTauri()) return Promise.reject(new BrewUpgradeError("unsupported_platform"));
  return invoke<void>("relay_brew_upgrade", { relayHostname: relayHostname ?? null }).catch((raw: unknown) => {
    throw toBrewUpgradeError(raw);
  });
}

export function cancelLocalInstall(): Promise<void> {
  if (!inTauri()) return Promise.reject(new Error(NOT_IN_TAURI));
  return invoke<void>("relay_setup_cancel");
}

export function getLocalInstallStatus(): Promise<InstallRunStatus | null> {
  if (!inTauri()) return Promise.resolve(null);
  return invoke<InstallRunStatus | null>("relay_setup_status");
}

/** Subscribes to the installer's log lines. Fire-and-forget on the Rust
 * side — a line emitted with no listener is gone, which is why the caller
 * hydrates from `getLocalInstallStatus()` first and watches `seq` for gaps. */
export function onInstallLog(handler: (event: InstallLogEvent) => void): Promise<UnlistenFn> {
  if (!inTauri()) return Promise.resolve(() => {});
  return listen<InstallLogEvent>("relay-setup-log", (event) => handler(event.payload));
}

export function onInstallDone(handler: (event: InstallDoneEvent) => void): Promise<UnlistenFn> {
  if (!inTauri()) return Promise.resolve(() => {});
  return listen<InstallDoneEvent>("relay-setup-done", (event) => handler(event.payload));
}
