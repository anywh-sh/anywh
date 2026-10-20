// What the rest of the shell (sidebar rows, tabs, the status bar) needs to
// know about a room without drawing its canvas: how many of its agents run,
// wait for the person or failed. Derived from the room channel; held in a
// tiny external store so a row or a tab subscribes to one room only.
import { useSyncExternalStore } from "react";
import { cardStatus } from "@/lib/sala/agentCard";
import type { RoomAgent } from "@/lib/relay/roomClient";

export interface RoomStatus {
  agents: number;
  /** Agents with a turn running or about to run. */
  working: number;
  /** Agents with a question or approval waiting for the person. */
  needsYou: number;
  failed: number;
  /** Every agent has reported done (the room is complete). */
  completed: boolean;
}

export const NO_ROOM_STATUS: RoomStatus = { agents: 0, working: 0, needsYou: 0, failed: 0, completed: false };

/** A room is complete when its principal is idle and every worker that is
 * still in it has reported done. A stopped worker does not hold it open (the
 * person ended it); a failed or blocked one does, since someone has to look. */
export function isRoomCompleted(agents: readonly RoomAgent[]): boolean {
  const principal = agents.find((a) => a.role === "principal");
  const workers = agents.filter((a) => a.role === "worker" && a.state !== "stopped");
  if (!principal || workers.length === 0) return false;
  if (principal.state === "working" || principal.state === "queued" || principal.needsYou.length > 0 || principal.state === "awaiting_user") return false;
  return workers.every((a) => a.state === "done" && a.needsYou.length === 0);
}

export function roomStatusOf(agents: readonly RoomAgent[]): RoomStatus {
  let working = 0;
  let needsYou = 0;
  let failed = 0;
  const liveWorkers = agents.filter((a) => a.role === "worker" && (a.state === "working" || a.state === "queued")).length;
  for (const agent of agents) {
    const { tone } = cardStatus(agent, agent.role === "principal" ? liveWorkers : 0);
    if (tone === "wait") needsYou += 1;
    else if (tone === "run" || tone === "start") working += 1;
    else if (tone === "fail") failed += 1;
  }
  return { agents: agents.length, working, needsYou, failed, completed: isRoomCompleted(agents) };
}

export function sameRoomStatus(a: RoomStatus, b: RoomStatus): boolean {
  return a.agents === b.agents && a.working === b.working && a.needsYou === b.needsYou && a.failed === b.failed && a.completed === b.completed;
}

const statuses = new Map<string, RoomStatus>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, RoomStatus> = new Map();

function emit(): void {
  snapshot = new Map(statuses);
  for (const listener of listeners) listener();
}

export function publishRoomStatus(roomId: string, status: RoomStatus): void {
  const before = statuses.get(roomId);
  if (before && sameRoomStatus(before, status)) return;
  statuses.set(roomId, status);
  emit();
}

export function forgetRoomStatus(roomId: string): void {
  if (statuses.delete(roomId)) emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every known room's status, by room id. */
export function useRoomStatuses(): ReadonlyMap<string, RoomStatus> {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function useRoomStatus(roomId: string): RoomStatus | undefined {
  return useSyncExternalStore(subscribe, () => statuses.get(roomId));
}

/** For tests. */
export function resetRoomStatuses(): void {
  statuses.clear();
  emit();
}

export interface RoomTotals {
  working: number;
  needsYou: number;
  failed: number;
}

export function totalRoomStatuses(all: Iterable<RoomStatus>): RoomTotals {
  const totals = { working: 0, needsYou: 0, failed: 0 };
  for (const s of all) {
    totals.working += s.working;
    totals.needsYou += s.needsYou;
    totals.failed += s.failed;
  }
  return totals;
}
