import { invoke } from "@tauri-apps/api/core";
import type { UpdateMode } from "@/lib/settings";
import { inTauri } from "@/lib/platform/tauri";

/**
 * What an `updateMode` means once the install origin is known. Kept out of
 * `appUpdate.ts` because telemetry needs the same answer at boot, and that
 * module imports telemetry — a cycle if it lived there.
 */

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

export const UNKNOWN_ORIGIN: InstallOrigin = { channel: "unknown", updatable: false, execPath: "", marker: null };

export async function getInstallOrigin(): Promise<InstallOrigin> {
  if (!inTauri()) return UNKNOWN_ORIGIN;
  return invoke<InstallOrigin>("app_install_source");
}

/**
 * The mode a check actually runs in. `auto-download` is the automatic mode
 * (download, install in the background, offer a restart); its stored name
 * predates installing, and renaming it would orphan every saved value.
 *
 * - no saved value: automatic where the install can replace itself
 *   (`updatable`), notify-only everywhere else;
 * - `auto-download` saved: automatic, but only on an updatable origin — a
 *   download that can never be applied would just be stranded on disk;
 * - `notify` saved: an explicit choice, kept as "tell me, never download" —
 *   the old default, now opt-in. A `notify` written by a build before the
 *   background updater was not a choice; `migrateUpdateMode` (`settings.ts`)
 *   drops those on load, so one reaching here was picked in the new dialog;
 * - `off`: no checks at all.
 */
export function resolveUpdateMode(saved: UpdateMode | undefined, updatable: boolean): UpdateMode {
  if (saved === "off" || saved === "notify") return saved;
  return updatable ? "auto-download" : "notify";
}
