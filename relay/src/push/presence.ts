/**
 * Which sessions a person is looking at right now, as far as the relay can
 * tell. Each client says so over its chat socket and has to keep saying so:
 * a claim is a lease, not a flag. A phone's socket stays "connected" long
 * after the app was suspended and no JS runs, so a flag set once would mute
 * push for that session until the relay restarted. Pure — the clock is a
 * parameter.
 */

/** How long a "visible" claim holds without being repeated. The client
 * repeats it every 20 s, so one lost message is tolerated; an app that
 * stopped running silences its session for at most this long. */
export const PRESENCE_LEASE_MS = 45_000;

/** The expiry a claim earns: `null` means "not looking" (nothing to keep). */
export function leaseExpiry(visible: boolean, now: number, leaseMs: number = PRESENCE_LEASE_MS): number | null {
  return visible ? now + leaseMs : null;
}

/** True while at least one claim is still live. Expiry is exclusive: a lease
 * ending exactly now has ended. */
export function isAnyoneLooking(expiries: Iterable<number>, now: number): boolean {
  for (const expiry of expiries) if (expiry > now) return true;
  return false;
}
