import { useSyncExternalStore } from "react";
import { isFirstRunActive, subscribeFirstRun } from "@/lib/firstRun";

/** Reactive read of `firstRun.ts`'s flag — the second half of `App`'s gate
 * predicate, same "read outside React, subscribe from a hook" shape as
 * `useProfiles`. */
export function useFirstRunActive(): boolean {
  return useSyncExternalStore(subscribeFirstRun, isFirstRunActive);
}
