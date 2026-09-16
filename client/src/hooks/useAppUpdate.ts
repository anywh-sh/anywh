import { useSyncExternalStore } from "react";
import { getAvailableUpdate, subscribeAppUpdate, type UpdateAvailableInfo } from "@/lib/appUpdate";

/** Reactive read of the update the last scheduled check found, if any —
 * `null` while none is available or it was dismissed. The check itself runs
 * on a timer in `App.tsx`, never from here, so this hook only ever reads. */
export function useAppUpdate(): UpdateAvailableInfo | null {
  return useSyncExternalStore(subscribeAppUpdate, getAvailableUpdate);
}
