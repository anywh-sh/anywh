/**
 * Tracks which profiles' connections have been permanently revoked
 * (`BrokerRevokedError` — a 410 from the broker) — a small, module-level
 * store in the same shape as `profiles.ts`'s own (`getProfiles`/
 * `subscribeProfiles`), since this needs the same "read outside React,
 * subscribe from a hook" access every one of the four independent
 * reconnect loops (chat, sessions/watch, terminal, files) can reach.
 *
 * Deliberately in-memory only, never persisted — a profile marked here
 * stays revoked only for the life of this app run; removing the profile
 * (the action the banner offers) is what actually resolves it, not
 * clearing this flag on its own.
 */
const revokedProfileIds = new Set<string>();
const listeners = new Set<() => void>();

/** A frozen copy handed to `useSyncExternalStore`, replaced on every change.
 * The mutable set above can't serve as the snapshot: its identity never
 * changes, so React would never see an update. A consumer that renders every
 * profile's state at once (the switcher's badges) needs this rather than a
 * per-id boolean, which only re-renders when that one id flips. */
let snapshot: ReadonlySet<string> = new Set();

function notify(): void {
  snapshot = new Set(revokedProfileIds);
  for (const listener of listeners) listener();
}

export function markProfileRevoked(profileId: string): void {
  if (revokedProfileIds.has(profileId)) return;
  revokedProfileIds.add(profileId);
  notify();
}

/** Called after the profile is removed (or the banner is dismissed) so a
 * profile id can be reused (e.g. re-paired later) without carrying a stale
 * revoked flag. */
export function clearProfileRevoked(profileId: string): void {
  if (!revokedProfileIds.has(profileId)) return;
  revokedProfileIds.delete(profileId);
  notify();
}

export function isProfileRevoked(profileId: string): boolean {
  return revokedProfileIds.has(profileId);
}

/** Every revoked profile at once — for UI that shows the state of the whole
 * list, not of one profile. */
export function getRevokedProfiles(): ReadonlySet<string> {
  return snapshot;
}

export function subscribeProfileRevocation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
