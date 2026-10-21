import { useEffect, useRef } from "react";
import { markSessionCompleted, markSessionsSeen, roomIsBusy, roomJustCompleted } from "@/lib/format/sessionCompletion";
import { useRoomStatuses, type RoomStatus } from "@/lib/sala/roomStatus";

/**
 * Keeps the sidebar's "Completed" state in step with what the app observes:
 * a room that finishes while nobody looks at it enters; a session that runs
 * again, a room that gets busy, or the session the person is looking at
 * leaves. (An ordinary turn entering is recorded where the turn ends, in
 * `onTurnComplete`.)
 */
export function useSessionCompletionTracking(running: ReadonlySet<string>, activeTabId: string | null, windowFocused: boolean): void {
  const rooms = useRoomStatuses();
  const before = useRef<ReadonlyMap<string, RoomStatus>>(rooms);
  const focused = windowFocused ? activeTabId : null;

  useEffect(() => {
    const entering: string[] = [];
    const leaving: string[] = [];
    for (const [id, status] of rooms) {
      if (roomIsBusy(status)) leaving.push(id);
      else if (id !== focused && roomJustCompleted(before.current.get(id), status)) entering.push(id);
    }
    before.current = rooms;
    markSessionsSeen(leaving);
    for (const id of entering) markSessionCompleted(id);
  }, [rooms, focused]);

  useEffect(() => {
    markSessionsSeen(running);
  }, [running]);

  // Opening a session (or coming back to the window on it) is what sees it.
  useEffect(() => {
    if (focused) markSessionsSeen([focused]);
  }, [focused]);
}
