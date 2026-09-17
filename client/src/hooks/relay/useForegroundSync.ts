import { useEffect } from "react";

/** Slow enough to be invisible on the wire (the control registries are two
 * small JSON reads over the LAN/tailnet), fast enough that a change made on
 * another device shows up while you're still looking at this one. */
const POLL_INTERVAL_MS = 30_000;

/** Floor shared by every trigger, poll included: a burst of focus/visibility
 * events (alt-tabbing repeatedly, a window manager that fires `focus` twice)
 * can't drive `sync` more often than this, regardless of `poll`. */
const MIN_REFRESH_MS = 60_000;

export interface ForegroundSyncOptions {
  /** Arms the slow visible-tab poll. Default `true`. Off for a profile whose
   * `sync` can resume a suspended machine (tailnet/brokered) — reaching it
   * costs a resume, not a cheap LAN round-trip, so nothing should be paying
   * for that on a timer while the window just sits open and idle. Mount,
   * `visibilitychange` and `focus` still fire either way; only the timer is
   * gated. */
  poll?: boolean;
}

/**
 * Re-runs `sync` whenever this device might have fallen behind the host:
 * on mount, on the app coming back to the foreground, on the window
 * regaining focus, and — when `poll` is on — on a slow timer while visible.
 *
 * The three always-on triggers cover different gaps and none of them
 * subsumes the others. `visibilitychange` is the only one iOS reliably gives
 * when the app returns from the background. `focus` is what covers a desktop
 * window that was left visible behind another app — the document never
 * stops being "visible" there, so `visibilitychange` never fires. And
 * neither fires at all when the window just sits in front of you while the
 * change happens on another device, which is what the poll is for.
 *
 * `sync` must be stable (wrap it in `useCallback`) — it's a dependency, and
 * a new identity every render would re-arm the timer on every render.
 */
export function useForegroundSync(sync: () => void, options?: ForegroundSyncOptions): void {
  const poll = options?.poll ?? true;

  useEffect(() => {
    let lastRunAt = 0;

    function runThrottled(): void {
      const now = Date.now();
      if (now - lastRunAt < MIN_REFRESH_MS) return;
      lastRunAt = now;
      sync();
    }

    function syncIfVisible(): void {
      if (document.visibilityState === "visible") runThrottled();
    }

    runThrottled();
    document.addEventListener("visibilitychange", syncIfVisible);
    window.addEventListener("focus", runThrottled);
    const timer = poll ? window.setInterval(syncIfVisible, POLL_INTERVAL_MS) : undefined;

    return () => {
      document.removeEventListener("visibilitychange", syncIfVisible);
      window.removeEventListener("focus", runThrottled);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [sync, poll]);
}
