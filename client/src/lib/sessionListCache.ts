import type { SessionSummary } from "@/lib/relay-types";

/**
 * The session list of every profile this device has ever synced, in one
 * place — module-level store plus `localStorage`, the same shape
 * `profiles.ts` already uses (`get*`/`set*`/`subscribe*`), so it can be read
 * outside React and subscribed to from a hook.
 *
 * It exists because the sidebar lists every profile at once now. Before,
 * `useSessionNames` held the active profile's list in `useState` (thrown
 * away on every profile switch) and the search dialog refetched every
 * profile from scratch each time it opened (kept nothing). Neither survives
 * a profile switch, let alone a restart, so neither can back a list that is
 * supposed to show profiles the user is not currently connected to.
 *
 * The deliberate non-goal: this never fetches anything. Writes come from
 * whoever already had a reason to talk to a relay — the active profile's
 * own fetch and live socket, or the one-time bootstrap for a profile that
 * has never been synced on this device. Nothing here fans out across
 * profiles on a timer, because waking every profile at once is exactly the
 * cost this design is avoiding.
 */
export interface CachedProfileSessions {
  sessions: SessionSummary[];
  /** When the full list was last replaced by a real fetch. `null` means this
   * device has never synced the profile, which is the signal the bootstrap
   * in `useSessionListBootstrap` looks for.
   *
   * Only a whole-list fetch moves it: the incremental mirrors below (a title
   * arriving, a delete, a reorder) ride on a connection that is already
   * live, and treating them as a sync would make a profile look freshly
   * checked because one row happened to change. */
  syncedAt: number | null;
}

export type SessionListCache = Record<string, CachedProfileSessions>;

const STORAGE_KEY = "anywh:session-list-cache";

function readPersisted(): SessionListCache {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, CachedProfileSessions] => isCachedProfileSessions(entry[1]),
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

/** Validated on read rather than trusted: this is the one piece of app state
 * that is persisted, shared across profiles and shaped by a relay response,
 * so a half-written or outdated entry would otherwise surface as a render
 * crash in the sidebar rather than as a missing row. */
function isCachedProfileSessions(value: unknown): value is CachedProfileSessions {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.sessions)) return false;
  if (candidate.syncedAt !== null && typeof candidate.syncedAt !== "number") return false;
  return candidate.sessions.every((session: unknown) => {
    if (typeof session !== "object" || session === null) return false;
    const entry = session as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.title !== "string") return false;
    return entry.lastActiveAt === null || typeof entry.lastActiveAt === "number";
  });
}

let cache: SessionListCache = readPersisted();
const listeners = new Set<() => void>();

const EMPTY: CachedProfileSessions = { sessions: [], syncedAt: null };

function commit(next: SessionListCache): void {
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode — the in-memory copy still works for this run,
    // it just won't survive a restart. Not worth failing a sync over.
  }
  for (const listener of listeners) listener();
}

/** Whole-map read, with a stable identity between writes so it can be handed
 * straight to `useSyncExternalStore` without tearing. */
export function getSessionListCache(): SessionListCache {
  return cache;
}

export function getCachedSessions(profileId: string): CachedProfileSessions {
  return cache[profileId] ?? EMPTY;
}

export function subscribeSessionListCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A full list from the relay — the only write that counts as a sync. */
export function setCachedSessions(profileId: string, sessions: SessionSummary[]): void {
  commit({ ...cache, [profileId]: { sessions, syncedAt: Date.now() } });
}

/**
 * Mirrors `useSessionNames.upsertTitle`: inserts a newly titled session at
 * the top, or updates the title of one already listed without moving it.
 * Same rule about `lastActiveAt` as there — only consulted when inserting,
 * so a rename doesn't reorder the list or change which recency group the
 * session falls into.
 */
export function upsertCachedSession(profileId: string, id: string, title: string, lastActiveAt?: number): void {
  const existing = cache[profileId] ?? EMPTY;
  const index = existing.sessions.findIndex((session) => session.id === id);
  const sessions =
    index === -1
      ? [{ id, title, lastActiveAt: lastActiveAt ?? Date.now() }, ...existing.sessions]
      : existing.sessions.map((session, i) => (i === index ? { ...session, title } : session));
  commit({ ...cache, [profileId]: { ...existing, sessions } });
}

export function removeCachedSession(profileId: string, id: string): void {
  const existing = cache[profileId];
  if (!existing) return;
  const sessions = existing.sessions.filter((session) => session.id !== id);
  if (sessions.length === existing.sessions.length) return;
  commit({ ...cache, [profileId]: { ...existing, sessions } });
}

/** Mirrors `useSessionNames.touch` — a session used again jumps back to the
 * top, with its timestamp moved so the recency grouping agrees with the
 * order. No-op for a session not listed yet (its first turn, still untitled). */
export function touchCachedSession(profileId: string, id: string): void {
  const existing = cache[profileId];
  if (!existing) return;
  const index = existing.sessions.findIndex((session) => session.id === id);
  if (index === -1) return;
  const sessions = [...existing.sessions];
  const [session] = sessions.splice(index, 1);
  sessions.unshift({ ...session, lastActiveAt: Date.now() });
  commit({ ...cache, [profileId]: { ...existing, sessions } });
}

/** Called when a profile is removed from the device — otherwise its rows
 * outlive it in storage and reappear if the same id is ever paired again. */
export function forgetCachedProfile(profileId: string): void {
  if (!(profileId in cache)) return;
  const next = { ...cache };
  delete next[profileId];
  commit(next);
}

/**
 * Drops every entry whose profile no longer exists on this device.
 *
 * Reconciliation rather than a `forgetCachedProfile` call next to each
 * `removeProfile`: there are already several ways a profile leaves (the
 * settings danger zone, the revoked banner, discarding a duplicate during
 * setup), and a persisted cache that only stays correct if every future
 * removal path remembers to clean up is a bug waiting to be written.
 *
 * An empty `knownIds` is ignored on purpose. The shell is the only caller
 * and it never mounts without a profile, so seeing none here means
 * something is mid-initialisation, not that the user deleted everything —
 * and when they do delete the last one, the shell unmounts before this
 * would run; the rows are pruned the next time a profile exists.
 */
export function pruneCachedProfiles(knownIds: ReadonlySet<string>): void {
  if (knownIds.size === 0) return;
  const stale = Object.keys(cache).filter((profileId) => !knownIds.has(profileId));
  if (stale.length === 0) return;
  const next = { ...cache };
  for (const profileId of stale) delete next[profileId];
  commit(next);
}
