import type { MergedSession } from "@/lib/format/sessionGrouping";
import type { CompletedMap } from "@/lib/format/sessionCompletion";
import type { RoomStatus } from "@/lib/sala/roomStatus";

export interface StateGroups {
  /** Rooms with a question or approval waiting for the person, or an agent that failed. */
  needsYou: MergedSession[];
  /** Sessions with a turn running, and rooms whose agents work. */
  running: MergedSession[];
  /** Finished while nobody looked and not opened since, latest finish first. */
  completed: MergedSession[];
  /** Everything else, in the order it came. */
  rest: MergedSession[];
}

/**
 * Splits the (already sorted) session list by what needs attention. Only a
 * room is known to wait for the person: an ordinary session's question is
 * not visible from the list. A session sits in one group only, the most
 * urgent that applies.
 */
export function groupByState(sessions: readonly MergedSession[], running: ReadonlySet<string>, rooms: ReadonlyMap<string, RoomStatus>, completed: CompletedMap = new Map()): StateGroups {
  const groups: StateGroups = { needsYou: [], running: [], completed: [], rest: [] };
  for (const session of sessions) {
    const room = session.room === true ? rooms.get(session.id) : undefined;
    if (room && (room.needsYou > 0 || room.failed > 0)) groups.needsYou.push(session);
    else if (running.has(session.id) || (room && room.working > 0)) groups.running.push(session);
    else if (completed.has(session.id)) groups.completed.push(session);
    else groups.rest.push(session);
  }
  groups.completed.sort((a, b) => (completed.get(b.id) ?? 0) - (completed.get(a.id) ?? 0));
  return groups;
}
