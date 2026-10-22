import type { RoomAgent } from "@/lib/relay/roomClient";
import { subtreeIds } from "@/lib/sala/layout";

/** What removing `ids` takes out of the room. Only workers are removed (the
 * principal is the room itself); an agent leaves with every agent below it,
 * so `roots` are the picked agents no other picked agent is above, and
 * `extra` counts the agents that go along without being picked. */
export interface RemovalPlan {
  roots: string[];
  all: string[];
  extra: number;
}

export function removalPlan(agents: readonly RoomAgent[], ids: readonly string[]): RemovalPlan {
  const byId = new Map(agents.map((a) => [a.agentId, a]));
  const picked = new Set(ids.filter((id) => byId.get(id)?.role === "worker"));
  const above = (id: string): boolean => {
    const seen = new Set<string>();
    let parent = byId.get(id)?.parentId;
    while (parent !== undefined && !seen.has(parent)) {
      if (picked.has(parent)) return true;
      seen.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    return false;
  };
  const roots = [...picked].filter((id) => !above(id));
  const all = [...new Set(roots.flatMap((id) => subtreeIds(agents, id)))];
  return { roots, all, extra: all.length - roots.length };
}
