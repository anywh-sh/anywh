import { invoke } from "@tauri-apps/api/core";
import { APP_VERSION } from "@/lib/install/appVersion";
import { isNewerVersion } from "@/lib/install/semver";
import { type AppSettings, type UpdateMode, readSettings, writeSettings } from "@/lib/settings";
import { inTauri } from "@/lib/platform/tauri";
import { downloadRealUpdate, type Update } from "@/lib/install/updaterPlugin";

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
// The downloaded-and-ready-to-install update — phase B3. Separate store from
// `current` above: that one is driven by the cheap GitHub check and can be
// dismissed per-version, this one holds a live `Update` resource (a handle
// into the Rust plugin, not plain data) and is only ever cleared by actually
// installing it or by a newer download replacing it.
// ---------------------------------------------------------------------------

let downloaded: Update | null = null;
const downloadListeners = new Set<() => void>();

function notifyDownload(): void {
  for (const listener of downloadListeners) listener();
}

/** Closes the previous `Update` resource (if any) before replacing it — an
 * `Update` extends Tauri's `Resource`, so an unclosed one leaks its Rust-side
 * handle for the rest of the app's run. */
function markDownloaded(update: Update): void {
  if (downloaded && downloaded !== update) void downloaded.close();
  downloaded = update;
  notifyDownload();
}

/** Called once the user actually installs it (see `updaterPlugin.ts`'s
 * `installAndRestart`) — the app is about to relaunch, so there's nothing
 * left to hold a reference to, but clearing it keeps the store honest if the
 * relaunch is ever slow enough for a re-render to observe it in between. */
export function clearDownloadedUpdate(): void {
  downloaded = null;
  notifyDownload();
}

export function getDownloadedUpdate(): Update | null {
  return downloaded;
}

export function subscribeDownloadedUpdate(listener: () => void): () => void {
  downloadListeners.add(listener);
  return () => downloadListeners.delete(listener);
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
  downloadUpdate: () => Promise<Update | null>;
}

const REAL_DEPS: CheckDeps = { getInstallOrigin, checkLatestRelease, downloadUpdate: downloadRealUpdate };

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

    // Real download only in auto-download mode, and only once per version —
    // the plugin's own check() keeps returning the same update every day
    // until the user actually restarts into it, since the running version
    // hasn't changed yet.
    if (nextApp.updateMode === "auto-download" && getDownloadedUpdate()?.version !== version) {
      try {
        const update = await deps.downloadUpdate();
        if (update) markDownloaded(update);
      } catch {
        // Best-effort — a network hiccup here is no different from one in
        // checkLatestRelease above, and the next scheduled check retries.
      }
    }
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
