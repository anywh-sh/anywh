import { invoke } from "@tauri-apps/api/core";
import { APP_VERSION } from "@/lib/appVersion";
import { isNewerVersion } from "@/lib/semver";
import { type AppSettings, type UpdateMode, readSettings, writeSettings } from "@/lib/settings";
import { inTauri } from "@/lib/tauri";

/**
 * Fase A2 of the in-app updater plan: the store `UpdateModal` reads from,
 * plus the scheduling policy and the Rust bindings that feed it. Same shape
 * as `profileRevocation.ts` — a module-level value, a listener set,
 * `useSyncExternalStore` on the consuming side — because this needs the
 * same "read outside React, subscribe from a hook" access.
 */

export interface UpdateAvailableInfo {
  /** Without a leading "v" — same convention `semver.ts` and `APP_VERSION` use. */
  version: string;
  htmlUrl: string;
}

let current: UpdateAvailableInfo | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function markUpdateAvailable(info: UpdateAvailableInfo): void {
  current = info;
  notify();
}

export function clearUpdate(): void {
  if (current === null) return;
  current = null;
  notify();
}

export function getAvailableUpdate(): UpdateAvailableInfo | null {
  return current;
}

export function subscribeAppUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Rust bindings — thin, guarded by inTauri() (localRelay.ts's discipline)
// ---------------------------------------------------------------------------

export interface InstallSourceMarker {
  version: number;
  method: string;
  channel: string;
  path: string;
  installedVersion: string;
  installedAt: string;
}

export interface InstallOrigin {
  channel: string;
  updatable: boolean;
  execPath: string;
  marker: InstallSourceMarker | null;
}

const UNKNOWN_ORIGIN: InstallOrigin = { channel: "unknown", updatable: false, execPath: "", marker: null };

export async function getInstallOrigin(): Promise<InstallOrigin> {
  if (!inTauri()) return UNKNOWN_ORIGIN;
  return invoke<InstallOrigin>("app_install_source");
}

export type LatestReleaseCheck =
  | { kind: "notModified" }
  | { kind: "available"; tagName: string; htmlUrl: string; etag: string | null }
  | { kind: "rateLimited"; retryAfterEpochMs: number | null };

/** Outside Tauri there is nothing to check against, and "nothing changed" is
 * the answer that makes every caller's fast path (skip, don't persist a
 * bogus etag) fire with no special-casing. */
export async function checkLatestRelease(etag: string | undefined): Promise<LatestReleaseCheck> {
  if (!inTauri()) return { kind: "notModified" };
  return invoke<LatestReleaseCheck>("app_check_latest_release", { etag });
}

// ---------------------------------------------------------------------------
// Policy — pure functions, the whole reason the scheduling logic is testable
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** `off` suppresses everything; otherwise due once both the 24h cadence and
 * any rate-limit backoff (`nextCheckAllowedAt`) have elapsed. */
export function isCheckDue(app: AppSettings | undefined, now: number): boolean {
  if ((app?.updateMode ?? "notify") === "off") return false;
  if (now - (app?.lastCheckedAt ?? 0) < CHECK_INTERVAL_MS) return false;
  if (now < (app?.nextCheckAllowedAt ?? 0)) return false;
  return true;
}

/** A non-updatable origin can't apply anything it downloads, so offering to
 * download it anyway would just strand the file — coerce to `notify`
 * instead of leaving a setting that silently does nothing. */
export function normalizeUpdateMode(mode: UpdateMode, updatable: boolean): UpdateMode {
  return mode === "auto-download" && !updatable ? "notify" : mode;
}

interface CheckDeps {
  getInstallOrigin: () => Promise<InstallOrigin>;
  checkLatestRelease: (etag: string | undefined) => Promise<LatestReleaseCheck>;
}

const REAL_DEPS: CheckDeps = { getInstallOrigin, checkLatestRelease };

async function runCheck(now: number, deps: CheckDeps): Promise<void> {
  const settings = readSettings();
  const app = settings.app;

  const origin = await deps.getInstallOrigin();
  const result = await deps.checkLatestRelease(app?.etag);

  const nextApp: AppSettings = { ...app, lastCheckedAt: now };
  if (app?.updateMode) nextApp.updateMode = normalizeUpdateMode(app.updateMode, origin.updatable);

  if (result.kind === "notModified") {
    writeSettings({ ...settings, app: nextApp });
    return;
  }

  if (result.kind === "rateLimited") {
    nextApp.nextCheckAllowedAt = result.retryAfterEpochMs ?? undefined;
    writeSettings({ ...settings, app: nextApp });
    return;
  }

  const version = result.tagName.replace(/^v/, "");
  nextApp.lastSeenVersion = version;
  if (result.etag) nextApp.etag = result.etag;
  writeSettings({ ...settings, app: nextApp });

  if (isNewerVersion(version, APP_VERSION)) {
    markUpdateAvailable({ version, htmlUrl: result.htmlUrl });
  }
}

/**
 * The scheduled entry point (called from a 24h interval in `App.tsx`, never
 * from the banner — see that component for why). `deps` defaults to the real
 * Rust bindings; tests inject fakes here instead of mocking Tauri's IPC,
 * the same kind of seam the relay's tests use at the `claude` process
 * boundary.
 */
export async function performUpdateCheck(now: number = Date.now(), deps: CheckDeps = REAL_DEPS): Promise<void> {
  if (!isCheckDue(readSettings().app, now)) return;
  await runCheck(now, deps);
}

/** The title bar's "Check for updates" item — same check, deliberately
 * bypassing `isCheckDue`: a user pressing the button is the due condition. */
export async function forceUpdateCheck(deps: CheckDeps = REAL_DEPS): Promise<void> {
  await runCheck(Date.now(), deps);
}
