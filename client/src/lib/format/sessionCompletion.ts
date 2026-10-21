// Which sessions finished their work while the person was not looking, and
// still have not been opened since. They sit in the sidebar's "Completed"
// group with no time limit; opening one (or "clear") sends it back to Recent.
//
// The state is a map session id -> when it finished. Session ids are unique
// across profiles, so one flat map serves them all. Persisted in
// localStorage so a reload keeps the group, same shape as the session-list
// cache (module store + `useSyncExternalStore`).
import { useSyncExternalStore } from "react";
import type { RoomStatus } from "@/lib/sala/roomStatus";

export type CompletedMap = ReadonlyMap<string, number>;

/** Bounds the persisted map: the oldest entries go first. */
const MAX_ENTRIES = 200;

const STORAGE_KEY = "anywh:completed-sessions";

/** Adds a finished session. Returns the same map when nothing changes. */
export function withCompletion(map: CompletedMap, id: string, at: number): CompletedMap {
  if (map.get(id) === at) return map;
  const next = new Map(map);
  next.delete(id);
  next.set(id, at);
  while (next.size > MAX_ENTRIES) {
    const oldest = next.keys().next();
    if (oldest.done) break;
    next.delete(oldest.value);
  }
  return next;
}

/** Drops the given sessions (opened, running again, deleted). Same map when none is in it. */
export function withoutCompletion(map: CompletedMap, ids: Iterable<string>): CompletedMap {
  let next: Map<string, number> | null = null;
  for (const id of ids) {
    if (!map.has(id)) continue;
    next ??= new Map(map);
    next.delete(id);
  }
  return next ?? map;
}

/** True when a room just went from "not complete" to complete with nothing
 * left that needs the person: the moment it belongs in Completed. A room seen
 * for the first time (`before` undefined) never counts — that is a reload or
 * a first connection, not a work finishing in front of us. */
export function roomJustCompleted(before: RoomStatus | undefined, after: RoomStatus): boolean {
  if (!before || before.completed) return false;
  return after.completed && after.working === 0 && after.needsYou === 0 && after.failed === 0;
}

/** True when a room is doing something that takes it out of Completed. */
export function roomIsBusy(status: RoomStatus): boolean {
  return status.working > 0 || status.needsYou > 0 || status.failed > 0;
}

function readPersisted(): CompletedMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const entries = parsed.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number");
    return new Map(entries);
  } catch {
    return new Map();
  }
}

let state: CompletedMap = readPersisted();
const listeners = new Set<() => void>();

function commit(next: CompletedMap): void {
  if (next === state) return;
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Quota or private mode: the in-memory copy still works for this run.
  }
  for (const listener of listeners) listener();
}

/** A turn (or a room) finished while nobody was looking at it. */
export function markSessionCompleted(id: string, at: number = Date.now()): void {
  commit(withCompletion(state, id, at));
}

/** The person opened these sessions, or they are busy again. */
export function markSessionsSeen(ids: Iterable<string>): void {
  commit(withoutCompletion(state, ids));
}

/** "Clear": every completed session counts as seen at once. */
export function clearCompletedSessions(): void {
  commit(new Map());
}

export function getCompletedSessions(): CompletedMap {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCompletedSessions(): CompletedMap {
  return useSyncExternalStore(subscribe, getCompletedSessions);
}

/** For tests: replaces the state without touching storage. */
export function resetCompletedSessionsForTest(): void {
  state = new Map();
  for (const listener of listeners) listener();
}
