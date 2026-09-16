import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { inTauri } from "@/lib/tauri";

export type { Update };

/**
 * Phase B3's actual download path — separate from `checkLatestRelease`
 * (`appUpdate.ts`), which stays the cheap, ETag-cached GitHub API poll every
 * scheduled check makes to decide *whether* anything is newer. This one
 * talks to `latest.json`, verifies the update's signature against the
 * pubkey baked into `tauri.conf.json`, and pulls the actual bytes — real
 * cost, so it only ever runs from the auto-download branch of a check that
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
 * The only path that ever applies a downloaded update, and only ever from
 * an explicit click (`UpdateModal`) — never automatically, regardless of
 * `updateMode`. On Windows `install()` itself exits the app via the NSIS
 * installer; `relaunch()` is what actually brings the app back on
 * macOS/Linux, and is a no-op to wait on there since Windows never returns
 * from the call above it.
 */
export async function installAndRestart(update: Update): Promise<void> {
  await update.install();
  await relaunch();
}
