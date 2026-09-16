import { useEffect, useState, useSyncExternalStore } from "react";
import { getAvailableUpdate, getInstallOrigin, subscribeAppUpdate, type InstallOrigin, type UpdateAvailableInfo } from "@/lib/appUpdate";
import { type AppSettings, type UpdateMode, readSettings, subscribeSettings, writeSettings } from "@/lib/settings";

/** Reactive read of the update the last scheduled check found, if any —
 * `null` while none is available or it was dismissed. The check itself runs
 * on a timer in `App.tsx`, never from here, so this hook only ever reads. */
export function useAppUpdate(): UpdateAvailableInfo | null {
  return useSyncExternalStore(subscribeAppUpdate, getAvailableUpdate);
}

/** Reactive read/write of the app-wide update settings — same read/write
 * pair over `settings.ts` as `useModelPreference`, just for the `app` field
 * instead of a per-profile one. */
export function useAppUpdateSettings(): { settings: AppSettings; setUpdateMode: (mode: UpdateMode) => void } {
  const store = useSyncExternalStore(subscribeSettings, readSettings);

  function setUpdateMode(mode: UpdateMode): void {
    const current = readSettings();
    writeSettings({ ...current, app: { ...current.app, updateMode: mode } });
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
