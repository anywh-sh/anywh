import type { RoomAgent, RoomCanvasArea } from "@/lib/relay/roomClient";
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

/** The labels of the areas `ids` would leave for a new one (`unnamed` for an
 * area with no label), each once, in the canvas's order. */
export function areasLeft(areas: readonly RoomCanvasArea[], ids: readonly string[], unnamed: string): string[] {
  const taken = new Set(ids);
  return areas.filter((a) => (a.members ?? []).some((m) => taken.has(m))).map((a) => (a.label.trim() === "" ? unnamed : a.label));
}

/** Whether a click adds to (or takes from) the selection: Shift anywhere, and
 * the platform's own modifier for it, Command on macOS and Control elsewhere
 * (Control-click on macOS is a secondary click). */
export function isAdditiveClick(event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, mac: boolean): boolean {
  return event.shiftKey || (mac ? event.metaKey : event.ctrlKey);
}

/** The selection after a modified click on `id`: a card already selected
 * the plain way joins in on the first one, and a selection that falls to
 * one card is a plain selection again (`single`). */
export function toggleInSelection(many: readonly string[], single: string | null, id: string): { many: string[]; single: string | null } {
  let next = [...many];
  if (next.length === 0 && single !== null && single !== id) next.push(single);
  next = next.includes(id) ? next.filter((x) => x !== id) : [...next, id];
  if (next.length === 1) return { many: [], single: next[0] };
  if (next.length === 0) return { many: [], single: null };
  return { many: next, single: null };
}
