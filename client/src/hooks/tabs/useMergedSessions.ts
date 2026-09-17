import { useMemo, useSyncExternalStore } from "react";
import { getSessionListCache, subscribeSessionListCache, type SessionListCache } from "@/lib/format/sessionListCache";
import { mergeProfileSessions, type MergedSession } from "@/lib/format/sessionGrouping";

/** Reactive read of the whole cache — re-renders whenever any profile's
 * rows change, from any of the writers (active profile fetch, live socket,
 * bootstrap, or a local action on a tab). */
export function useSessionListCache(): SessionListCache {
  return useSyncExternalStore(subscribeSessionListCache, getSessionListCache);
}

/**
 * The sidebar's list: every selected profile's cached sessions merged and
 * sorted newest-first.
 *
 * Memoized on the cache and the selection, both of which keep a stable
 * identity between real changes (the cache commits a new object only on a
 * write, the selection is a `Set` held in state). That matters because this
 * runs on every render of the shell — including the ones a sidebar collapse
 * causes, which is one of the two highest-frequency interactions in the app,
 * and where a merge+sort per render would be pure waste.
 */
export function useMergedSessions(selectedProfileIds: ReadonlySet<string>): MergedSession[] {
  const cache = useSessionListCache();
  return useMemo(() => mergeProfileSessions(cache, selectedProfileIds), [cache, selectedProfileIds]);
}
