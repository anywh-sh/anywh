import { invoke } from "@tauri-apps/api/core";
import { trackError } from "@/lib/telemetry/instrument";
import { APP_VERSION, isUnreleasedVersion } from "@/lib/install/appVersion";
import { isNewerVersion } from "@/lib/install/semver";
import { type AppSettings, readSettings, writeSettings } from "@/lib/settings";
import { inTauri } from "@/lib/platform/tauri";
import { currentPlatform } from "@/lib/platform/platform";
import { downloadRealUpdate, installDownloadedUpdate, type Update } from "@/lib/install/updaterPlugin";
import { getInstallOrigin, resolveUpdateMode, type InstallOrigin } from "@/lib/install/updateMode";

export { getInstallOrigin, resolveUpdateMode };
export type { InstallOrigin, InstallSourceMarker } from "@/lib/install/updateMode";

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
// The downloaded update. Separate store from `current` above: that one is
// driven by the cheap GitHub check, this one holds a live `Update` resource
// (a handle into the Rust plugin, not plain data) and is only ever cleared by
// restarting into it or by a newer download replacing it.
// ---------------------------------------------------------------------------

export interface ReadyUpdate {
  update: Update;
  /** Already applied to disk — the restart only relaunches. `false` where
   * installing ends the process (Windows), or after an install that failed:
   * the restart then installs it, the same as the Windows path. */
  installed: boolean;
  /** The title-bar prompt was dismissed; the status bar and the modal still
   * show it. Per run on purpose: once applied, the next launch is already the
   * new version, and an unapplied one deserves asking again. */
  dismissed: boolean;
}

let ready: ReadyUpdate | null = null;
const readyListeners = new Set<() => void>();

function notifyReady(): void {
  for (const listener of readyListeners) listener();
}

/** Closes the previous `Update` resource (if any) before replacing it — an
 * `Update` extends Tauri's `Resource`, so an unclosed one leaks its Rust-side
 * handle for the rest of the app's run. */
function markReady(update: Update, installed: boolean): void {
  if (ready && ready.update !== update) void ready.update.close();
  ready = { update, installed, dismissed: false };
  notifyReady();
}

export function dismissRestartPrompt(): void {
  if (!ready || ready.dismissed) return;
  ready = { ...ready, dismissed: true };
  notifyReady();
}

/** Called once the app is about to relaunch, so there's nothing left to hold
 * a reference to, but clearing it keeps the store honest if the relaunch is
 * ever slow enough for a re-render to observe it in between. */
export function clearReadyUpdate(): void {
  ready = null;
  notifyReady();
}

export function getReadyUpdate(): ReadyUpdate | null {
  return ready;
}

export function subscribeReadyUpdate(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Rust bindings — thin, guarded by inTauri() (localRelay.ts's discipline)
// ---------------------------------------------------------------------------

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

/** How often the app asks. The poll is a conditional GET (ETag), which GitHub
 * doesn't count against the anonymous limit when nothing changed, so the
 * cadence is about how soon a release reaches someone who never restarts. */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** `off` suppresses everything; otherwise due once both the cadence and any
 * rate-limit backoff (`nextCheckAllowedAt`) have elapsed. */
export function isCheckDue(app: AppSettings | undefined, now: number): boolean {
  if ((app?.updateMode ?? "notify") === "off") return false;
  if (now - (app?.lastCheckedAt ?? 0) < UPDATE_CHECK_INTERVAL_MS) return false;
  if (now < (app?.nextCheckAllowedAt ?? 0)) return false;
  return true;
}

/** Windows' NSIS installer closes the app to replace it, so there the update
 * can only be installed as the app goes away; macOS (`.app` swap) and Linux
 * (AppImage rewrite) replace the files under a running process. */
function installsInBackground(): boolean {
  return currentPlatform() !== "windows";
}

interface CheckDeps {
  getInstallOrigin: () => Promise<InstallOrigin>;
  checkLatestRelease: (etag: string | undefined) => Promise<LatestReleaseCheck>;
  downloadUpdate: () => Promise<Update | null>;
  /** Applies a downloaded update to disk — only called where
   * `installsInBackground` says it can run without ending the process. */
  installUpdate?: (update: Update) => Promise<void>;
  installsInBackground?: boolean;
  /** The running app's version — `APP_VERSION` unless a test says otherwise. */
  appVersion?: string;
}

const REAL_DEPS: CheckDeps = {
  getInstallOrigin,
  checkLatestRelease,
  downloadUpdate: downloadRealUpdate,
  installUpdate: installDownloadedUpdate,
};

/** A check can start while the previous one's download is still running (the
 * timer firing during a manual "Check for updates"); a second download would
 * race the first one's install over the same files. */
let downloading = false;

async function runCheck(now: number, deps: CheckDeps): Promise<void> {
  const settings = readSettings();
  const app = settings.app;

  const origin = await deps.getInstallOrigin();
  const appVersion = deps.appVersion ?? APP_VERSION;

  // A build no release stamped (a dev or source build, `0.0.0`) has no
  // place in the release order: every release would look newer, and
  // auto-download would replace a source build with the official one. So it
  // never asks. The e2e build is the exception on purpose: its forced
  // "e2e" origin (updater.rs) stands in for an installed release, which is
  // what the updater specs exercise.
  if (isUnreleasedVersion(appVersion) && origin.channel !== "e2e") {
    writeSettings({ ...settings, app: { ...app, lastCheckedAt: now } });
    return;
  }

  const result = await deps.checkLatestRelease(app?.etag);

  const nextApp: AppSettings = { ...app, lastCheckedAt: now };
  // Not written back: a saved `auto-download` that this origin can't honour
  // stays as the user chose it, in case the install later moves somewhere
  // that can (an app dragged into /Applications).
  const mode = resolveUpdateMode(app?.updateMode, origin.updatable);

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

  if (isNewerVersion(version, appVersion)) {
    markUpdateAvailable({ version, htmlUrl: result.htmlUrl });

    // Only once per version: the plugin's own check() keeps returning the
    // same update until the app restarts into it, since the running version
    // hasn't changed yet.
    if (mode === "auto-download" && getReadyUpdate()?.update.version !== version && !downloading) {
      downloading = true;
      try {
        const update = await deps.downloadUpdate();
        if (update) {
          let installed = false;
          if (deps.installsInBackground ?? installsInBackground()) {
            try {
              await (deps.installUpdate ?? installDownloadedUpdate)(update);
              installed = true;
            } catch {
              // Left downloaded: the restart button installs it, as on Windows.
              trackError("update_failed");
            }
          }
          markReady(update, installed);
        }
      } catch {
        trackError("update_failed");
        // Best-effort — a network hiccup here is no different from one in
        // checkLatestRelease above, and the next scheduled check retries.
      } finally {
        downloading = false;
      }
    }
  }
}

/**
 * The scheduled entry point (called from the interval in `App.tsx`, never
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
