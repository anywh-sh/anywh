import { useEffect, useState } from "react";
import { fetchAgentSubtasks, type RoomSubtask } from "@/lib/relay/roomClient";
import type { Profile } from "@/lib/profiles/profiles";

/** An agent's native subtasks, read when its panel opens and again when the
 * number of running ones changes (the channel reports that count). */
export function useAgentSubtasks(profile: Profile, roomId: string, agentId: string, running: number): { subtasks: RoomSubtask[]; reload: () => void } {
  const [subtasks, setSubtasks] = useState<RoomSubtask[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchAgentSubtasks(profile, roomId, agentId).then(
      (next) => {
        if (!cancelled) setSubtasks(next);
      },
      (error: unknown) => console.error("[anywh] failed to read an agent's subtasks", error),
    );
    return () => {
      cancelled = true;
    };
    // The profile object is rebuilt on edits that do not change where it connects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, roomId, agentId, running, tick]);
  return { subtasks, reload: () => setTick((n) => n + 1) };
}
