import { describe, expect, it } from "vitest";
import type { RoomAgent } from "@/lib/relay/roomClient";
import { removalPlan } from "@/lib/sala/selection";

function agent(agentId: string, parentId: string | undefined, role: RoomAgent["role"] = "worker"): RoomAgent {
  return { agentId, role, parentId, title: agentId, model: "haiku", runtime: "claude", createdBy: "agent", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, connectors: [] };
}

// main ─┬─ a ─┬─ a1 ── a11
//       │     └─ a2
//       └─ b
const room = [agent("main", undefined, "principal"), agent("a", "main"), agent("a1", "a"), agent("a11", "a1"), agent("a2", "a"), agent("b", "main")];

describe("removalPlan", () => {
  it("takes every agent below the one removed along, and counts them apart", () => {
    expect(removalPlan(room, ["a"])).toEqual({ roots: ["a"], all: ["a", "a1", "a2", "a11"], extra: 3 });
    expect(removalPlan(room, ["b"])).toEqual({ roots: ["b"], all: ["b"], extra: 0 });
  });

  it("removes a picked agent under another picked one through its ancestor, not twice", () => {
    expect(removalPlan(room, ["a11", "a", "b"])).toEqual({ roots: ["a", "b"], all: ["a", "a1", "a2", "a11", "b"], extra: 3 });
  });

  it("never removes the principal, nor an id the room does not have", () => {
    expect(removalPlan(room, ["main", "gone"])).toEqual({ roots: [], all: [], extra: 0 });
    expect(removalPlan(room, ["main", "b"]).roots).toEqual(["b"]);
  });
});
