import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { inTauri } from "@/lib/platform/tauri";
import { trackError } from "@/lib/telemetry/instrument";

export type { Update };

/**
 * Phase B3's actual download path — separate from `checkLatestRelease`
 * (`appUpdate.ts`), which stays the cheap, ETag-cached GitHub API poll every
 * scheduled check makes to decide *whether* anything is newer. This one
 * talks to `latest.json`, verifies the update's signature against the
 * pubkey baked into `tauri.conf.json`, and pulls the actual bytes — real
 * cost, so it only ever runs from the automatic branch of a check that
 * already knows a newer version exists and the origin can apply it
 * (`InstallOrigin.updatable`, checked before this is ever called).
 *
 * Outside Tauri there's no plugin to ask, so this returns `null` rather
 * than throwing — the same "nothing to report" contract
 * `checkLatestRelease` already uses.
 */
export async function downloadRealUpdate(): Promise<Update | null> {
  if (!inTauri()) return null;
  const update = await check();
  if (!update) return null;
  await update.download();
  return update;
}

/**
 * Applies a downloaded update to disk. What `Update.install()` does in the
 * plugin crate (tauri-plugin-updater 2.x, `updater.rs`) decides the whole
 * design:
 *
 * - macOS: extracts the `.app.tar.gz` next to the running bundle, swaps the
 *   directories and returns. The process keeps running, from the unlinked old
 *   files, until it exits.
 * - Linux AppImage: renames the running AppImage aside and writes the new one
 *   in its place, then returns; the running process keeps its mounted inode.
 * - Windows: extracts the NSIS installer, launches it with `ShellExecuteW`
 *   and calls `std::process::exit(0)` — it never returns, and the app is
 *   gone before the installer replaces the exe.
 *
 * So macOS/AppImage can install the moment the download verifies, and a later
 * quit-and-reopen already lands on the new version; Windows can only install
 * as the app goes away (`installOnClose`, or the restart button).
 */
export async function installDownloadedUpdate(update: Update): Promise<void> {
  await update.install();
}

/**
 * The restart button's action. `installed` updates only need the relaunch;
 * the rest install first, which on Windows ends the process itself and (with
 * the plugin's default `restartAfterInstall: true`, NSIS `/R`) has the
 * installer reopen the app, so `relaunch()` is only ever reached where the
 * install returned.
 */
export async function restartIntoUpdate(update: Update, installed: boolean): Promise<void> {
  if (!installed) await update.install();
  await relaunch();
}

/**
 * Close-time install for a downloaded update that has not been applied
 * (Windows; also macOS/Linux after a background install that failed): closing
 * the window (the title bar's close button, Alt+F4, the taskbar) installs it
 * on the way out instead of discarding it.
 *
 * The close must never be blocked by the install: the request is cancelled
 * only to run the install first, and whatever happens (the installer throws,
 * antivirus holds the file, extraction fails, or it returns on a platform
 * that doesn't exit), the window is then closed for real. `destroy()` is
 * tried first; if that is refused, a second `close()` goes through because
 * the handler stands aside once the install has had its turn.
 * Returns the unlisten function.
 */
export async function installOnClose(update: Update): Promise<() => void> {
  const window = getCurrentWindow();
  let installAttempted = false;
  return window.onCloseRequested(async (event) => {
    if (installAttempted) return;
    installAttempted = true;
    event.preventDefault();
    try {
      await update.install();
    } catch {
      trackError("update_failed");
    }
    try {
      await window.destroy();
    } catch {
      await window.close();
    }
  });
}
