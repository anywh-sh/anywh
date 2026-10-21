import { useSyncExternalStore } from "react";

// One interval for every clock on the canvas: ten cards counting seconds are
// ten subscribers to the same tick, not ten timers.
const listeners = new Set<() => void>();
let timer: number | undefined;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The current time, refreshed once a second while anything is subscribed. */
export function useSecondTick(): number {
  return useSyncExternalStore(subscribe, () => now);
}
