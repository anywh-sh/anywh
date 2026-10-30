import { useCallback, useSyncExternalStore } from "react";

/**
 * Below this width the status bar's usage indicator collapses to the
 * profile's square and the 5h percentage. 1024 is the first width the
 * indicator's full form (every agent, both windows) stops fitting beside the
 * session controls, not a framework breakpoint — the client has no `lg:`.
 */
export const COMPACT_STATUS_BAR_QUERY = "(max-width: 1023px)";

/**
 * Whether a media query matches, kept current as the window changes.
 * Read during render through `useSyncExternalStore` rather than set from an
 * effect, so the first frame already has the right answer instead of painting
 * the wide layout and swapping a tick later. Without `matchMedia` (a bare
 * test environment) nothing matches.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const snapshot = useCallback(
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/** The status bar's compact form (`COMPACT_STATUS_BAR_QUERY`). */
export function useIsCompactStatusBar(): boolean {
  return useMediaQuery(COMPACT_STATUS_BAR_QUERY);
}
