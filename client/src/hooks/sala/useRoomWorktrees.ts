import { useCallback, useEffect, useState } from "react";
import { fetchRoomWorktrees, type RoomWorktrees } from "@/lib/relay/roomClient";
import type { Profile } from "@/lib/profiles/profiles";

const EMPTY: RoomWorktrees = { worktrees: [], totalSizeBytes: 0 };

/** The room's worktrees, read when a panel that shows them opens and again
 * whenever `refreshKey` changes (an agent finished, a report arrived). Sizes
 * cost the relay a walk of each folder, so nothing here polls. */
export function useRoomWorktrees(profile: Profile, roomId: string, refreshKey: string, enabled = true): { data: RoomWorktrees; loaded: boolean; reload: () => void } {
  const [data, setData] = useState<RoomWorktrees>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchRoomWorktrees(profile, roomId).then(
      (next) => {
        if (cancelled) return;
        setData(next);
        setLoaded(true);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error("[anywh] failed to read the room's worktrees", error);
        setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
    // The profile object is rebuilt on edits that do not change where it connects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, roomId, refreshKey, tick, enabled]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, loaded, reload };
}
