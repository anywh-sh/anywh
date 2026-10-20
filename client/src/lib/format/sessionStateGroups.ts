import type { MergedSession } from "@/lib/format/sessionGrouping";
import type { RoomStatus } from "@/lib/sala/roomStatus";

export interface StateGroups {
  /** Rooms with a question or approval waiting for the person. */
  needsYou: MergedSession[];
  /** Sessions with a turn running, and rooms whose agents work. */
  running: MergedSession[];
  /** Everything else, in the order it came. */
  rest: MergedSession[];
}

/**
 * Splits the (already sorted) session list by what needs attention. Only a
 * room is known to wait for the person: an ordinary session's question is
 * not visible from the list. A session sits in one group only, the most
 * urgent that applies.
 */
export function groupByState(sessions: readonly MergedSession[], running: ReadonlySet<string>, rooms: ReadonlyMap<string, RoomStatus>): StateGroups {
  const groups: StateGroups = { needsYou: [], running: [], rest: [] };
  for (const session of sessions) {
    const room = session.room === true ? rooms.get(session.id) : undefined;
    if (room && room.needsYou > 0) groups.needsYou.push(session);
    else if (running.has(session.id) || (room && room.working > 0)) groups.running.push(session);
    else groups.rest.push(session);
  }
  return groups;
}
