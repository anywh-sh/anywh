import { useSyncExternalStore } from "react";

/**
 * Asks a room's tab to bring one of its agents forward: its conversation in
 * the agent pane and, for a worker, its card in view. Made from outside the
 * room (a ticket's screen, "Work on it in a room…"), possibly before the
 * room's tab exists, so the request waits here until that room takes it.
 */

/** The agent to focus; `null` is the principal. */
export interface RoomFocusRequest {
  agentId: string | null;
  /** Tells two requests for the same agent apart. */
  seq: number;
}

const pending = new Map<string, RoomFocusRequest>();
const listeners = new Set<() => void>();
let seq = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

export function requestRoomFocus(roomId: string, agentId: string | null): void {
  seq += 1;
  pending.set(roomId, { agentId, seq });
  notify();
}

/** Drops the room's request once it is acted on. */
export function takeRoomFocus(roomId: string, request: RoomFocusRequest): void {
  if (pending.get(roomId) !== request) return;
  pending.delete(roomId);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The room's pending request, if any. */
export function useRoomFocusRequest(roomId: string): RoomFocusRequest | null {
  return useSyncExternalStore(subscribe, () => pending.get(roomId) ?? null);
}
