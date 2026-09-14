import { useSyncExternalStore } from "react";
import { getFirstRunSnapshot, subscribeFirstRun, type FirstRunSnapshot } from "@/lib/firstRun";

/** Reactive read of `firstRun.ts`'s flags — what `App`'s gate decides on,
 * same "read outside React, subscribe from a hook" shape as `useProfiles`. */
export function useFirstRun(): FirstRunSnapshot {
  return useSyncExternalStore(subscribeFirstRun, getFirstRunSnapshot);
}
