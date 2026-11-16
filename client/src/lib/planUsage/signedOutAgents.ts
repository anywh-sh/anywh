import { profileDataState, type ProfilePlanUsage } from "@/lib/planUsage/derive";

/**
 * Which agent has no login on which profile, for the chat to offer a sign-in
 * where it is needed. The plan usage watch already knows (it is the one that
 * reads each profile's logins), and only `App` holds it: `App` publishes
 * here, and any chat panel reads one profile/agent pair without the whole
 * plan usage state being threaded down to it. Module-level store, the same
 * shape as `lib/profiles/profileRevocation.ts`.
 */
let byProfile: Readonly<Record<string, ProfilePlanUsage>> = {};
const listeners = new Set<() => void>();

export function publishPlanUsage(next: Readonly<Record<string, ProfilePlanUsage>>): void {
  if (next === byProfile) return;
  byProfile = next;
  for (const listener of listeners) listener();
}

let refresher: ((profileId: string, runtime: string) => void) | undefined;

/** How `App` re-reads one profile's plan usage, past the cache. */
export function publishPlanUsageRefresh(refresh: (profileId: string, runtime: string) => void): void {
  refresher = refresh;
}

/** Asks for a fresh read of `runtime` on `profileId`: a "signed out" the
 * chat is acting on may be stale (signed in from a terminal on the host,
 * say), and a fresh read is what lifts it. */
export function requestPlanUsageRefresh(profileId: string, runtime: string): void {
  refresher?.(profileId, runtime);
}

export function subscribePlanUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Pure: whether `agentId` has no login on `profileId`, as of a live read.
 * Stale data (a profile offline) says nothing: no banner for a login that
 * may have come back meanwhile. */
export function isAgentSignedOut(state: Readonly<Record<string, ProfilePlanUsage>>, profileId: string, agentId: string): boolean {
  const entry = state[profileId];
  if (profileDataState(entry) !== "live") return false;
  return entry?.runtimes?.some((usage) => usage.runtime === agentId && usage.status === "signed_out") ?? false;
}

/** One profile's plan usage as last published (`undefined` until App has
 * one) — for a view that wants it without the whole state. */
export function planUsageFor(profileId: string): ProfilePlanUsage | undefined {
  return byProfile[profileId];
}

export function agentSignedOutNow(profileId: string, agentId: string): boolean {
  return isAgentSignedOut(byProfile, profileId, agentId);
}
