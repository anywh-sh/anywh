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
  agentBin: string;
  agentPath: string | null;
  agentLoggedIn: boolean | null;
  agentError: string | null;
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

export type CloseAction = "background" | "cancel" | "keep";

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

export function cancelLocalInstall(): Promise<void> {
  if (!inTauri()) return Promise.reject(new Error(NOT_IN_TAURI));
  return invoke<void>("relay_setup_cancel");
}

export function getLocalInstallStatus(): Promise<InstallRunStatus | null> {
  if (!inTauri()) return Promise.resolve(null);
  return invoke<InstallRunStatus | null>("relay_setup_status");
}

export function confirmCloseDuringInstall(action: CloseAction): Promise<void> {
  if (!inTauri()) return Promise.resolve();
  return invoke<void>("relay_setup_confirm_close", { action });
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

/** Rust held a window close because an install is alive; the UI owes it a
 * decision through `confirmCloseDuringInstall`. */
export function onCloseRequestedDuringInstall(handler: () => void): Promise<UnlistenFn> {
  if (!inTauri()) return Promise.resolve(() => {});
  return listen("relay-setup-close-requested", () => handler());
}
