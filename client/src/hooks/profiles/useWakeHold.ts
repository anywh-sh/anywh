import { useEffect, useState, useSyncExternalStore } from "react";
import { subscribeThrottleHolds, throttleHoldFor } from "@/lib/profiles/tailnetBroker";

/** When `profileId`'s machine can be woken again, while the broker's
 * resume-budget refusal holds every grant request for it (tailnetBroker.ts)
 * — `null` otherwise, and again once that time passes. For UI outside the
 * chat panel (the status bar) that would otherwise say "reconnecting" about
 * a connection nobody is attempting. */
export function useWakeHold(profileId: string | undefined): Date | null {
  const hold = useSyncExternalStore(subscribeThrottleHolds, () => (profileId ? throttleHoldFor(profileId) : undefined));
  const [, setExpired] = useState(0);
  const active = hold?.reason === "resume_budget_exhausted" && hold.until > Date.now() ? hold : undefined;

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setExpired((n) => n + 1), Math.max(0, active.until - Date.now()));
    return () => clearTimeout(timer);
  }, [active]);

  return active ? (active.retryAt ?? new Date(active.until)) : null;
}
