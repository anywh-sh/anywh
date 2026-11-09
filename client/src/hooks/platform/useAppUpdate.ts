import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getAvailableUpdate,
  getUpdateActivity,
  subscribeUpdateActivity,
  type UpdateActivity,
  clearReadyUpdate,
  getReadyUpdate,
  getInstallOrigin,
  subscribeAppUpdate,
  subscribeReadyUpdate,
  type InstallOrigin,
  type ReadyUpdate,
  type UpdateAvailableInfo,
} from "@/lib/install/appUpdate";
import { inTauri } from "@/lib/platform/tauri";
import { installOnClose, restartIntoUpdate } from "@/lib/install/updaterPlugin";
import {
  type AppSettings,
  type UpdateMode,
  UPDATE_MODE_VERSION,
  readSettings,
  subscribeSettings,
  writeSettings,
} from "@/lib/settings";

/** Reactive read of the update the last scheduled check found, if any —
 * `null` while none is available or it was dismissed. The check itself runs
 * on a timer in `App.tsx`, never from here, so this hook only ever reads. */
export function useAppUpdate(): UpdateAvailableInfo | null {
  return useSyncExternalStore(subscribeAppUpdate, getAvailableUpdate);
}

/** Reactive read of an update the automatic mode has already fetched and
 * verified (and, where the platform allows, installed) — non-`null` means
 * there's nothing left to do but restart (`restartIntoUpdate` in
 * `updaterPlugin.ts`), never another download. */
export function useReadyUpdate(): ReadyUpdate | null {
  return useSyncExternalStore(subscribeReadyUpdate, getReadyUpdate);
}

/** Reactive read of what the updater is doing (downloading, or the last
 * download failed) — drives the modal's status text. */
export function useUpdateActivity(): UpdateActivity {
  return useSyncExternalStore(subscribeUpdateActivity, getUpdateActivity);
}

/** The restart-into-update action shared by the title-bar button and the
 * modal: one copy, so the two cannot drift. `restarting` disables the control
 * while the install/relaunch runs; if either refuses (the app stays up) it
 * re-arms for another press instead of staying stuck, and on success the
 * ready update is cleared. */
export function useRestartIntoUpdate(): { restart: () => Promise<void>; restarting: boolean } {
  const ready = useReadyUpdate();
  const [restarting, setRestarting] = useState(false);

  async function restart(): Promise<void> {
    if (!ready || restarting) return;
    setRestarting(true);
    try {
      await restartIntoUpdate(ready.update, ready.installed);
    } catch {
      setRestarting(false);
      return;
    }
    clearReadyUpdate();
  }

  return { restart, restarting };
}

/** Registers the close-time install for a downloaded update that has not been
 * installed yet. A no-op while there is none, outside Tauri, and on
 * macOS/Linux, where the update is already on disk by the time it is ready. */
export function useInstallOnClose(): void {
  const ready = useReadyUpdate();
  const pending = ready !== null && !ready.installed ? ready.update : null;

  useEffect(() => {
    if (!pending || !inTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void installOnClose(pending).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [pending]);
}

/** Reactive read/write of the app-wide update settings — same read/write
 * pair over `settings.ts` as `useModelPreference`, just for the `app` field
 * instead of a per-profile one. */
export function useAppUpdateSettings(): { settings: AppSettings; setUpdateMode: (mode: UpdateMode) => void } {
  const store = useSyncExternalStore(subscribeSettings, readSettings);

  function setUpdateMode(mode: UpdateMode): void {
    const current = readSettings();
    writeSettings({ ...current, app: { ...current.app, updateMode: mode, updateModeVersion: UPDATE_MODE_VERSION } });
  }

  return { settings: store.app ?? {}, setUpdateMode };
}

/** One-shot probe of whether this install can even apply an update on its
 * own — `null` until the Rust round trip answers. Not part of the
 * `appUpdate.ts` store: nothing else needs to react to it changing, since it
 * can't change within a single run of the app. */
export function useInstallOrigin(): InstallOrigin | null {
  const [origin, setOrigin] = useState<InstallOrigin | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getInstallOrigin().then((result) => {
      if (!cancelled) setOrigin(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return origin;
}
