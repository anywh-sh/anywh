import { useEffect, useState } from "react";
import { fetchAgentSubtasks, type RoomAgent, type RoomSubtask } from "@/lib/relay/roomClient";
import type { Profile } from "@/lib/profiles/profiles";

/** What of an agent's subtasks the channel reports, as one value: it changes
 * when one starts, ends or is stopped, not on each of its steps. */
export function subtasksKey(agent: Pick<RoomAgent, "subtasks" | "subtasksRunning">): string {
  return `${String(agent.subtasksRunning)}:${(agent.subtasks ?? []).map((task) => `${task.taskId}=${task.status}`).join(",")}`;
}

/** An agent's native subtasks (the whole list, history included), read when
 * its panel opens and again whenever `key` changes (`subtasksKey`). */
export function useAgentSubtasks(profile: Profile, roomId: string, agentId: string, key: string): { subtasks: RoomSubtask[]; reload: () => void } {
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
  }, [profile.id, roomId, agentId, key, tick]);
  return { subtasks, reload: () => setTick((n) => n + 1) };
}
