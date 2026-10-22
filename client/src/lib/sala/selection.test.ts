import { describe, expect, it } from "vitest";
import type { RoomAgent } from "@/lib/relay/roomClient";
import { areasLeft, isAdditiveClick, removalPlan, toggleInSelection } from "@/lib/sala/selection";

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

describe("isAdditiveClick", () => {
  const click = (keys: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>) => ({ shiftKey: false, metaKey: false, ctrlKey: false, ...keys });
  it("takes Shift everywhere, Command on macOS and Control elsewhere", () => {
    expect(isAdditiveClick(click({ shiftKey: true }), true)).toBe(true);
    expect(isAdditiveClick(click({ shiftKey: true }), false)).toBe(true);
    expect(isAdditiveClick(click({ metaKey: true }), true)).toBe(true);
    expect(isAdditiveClick(click({ ctrlKey: true }), false)).toBe(true);
    // Control-click is a secondary click on macOS, and Windows/Linux keep the Meta key for the system.
    expect(isAdditiveClick(click({ ctrlKey: true }), true)).toBe(false);
    expect(isAdditiveClick(click({ metaKey: true }), false)).toBe(false);
    expect(isAdditiveClick(click({}), false)).toBe(false);
  });
});

describe("toggleInSelection", () => {
  it("brings the card selected the plain way in on the first modified click", () => {
    expect(toggleInSelection([], "a", "b")).toEqual({ many: ["a", "b"], single: null });
  });

  it("adds and takes out, and falls back to a plain selection at one", () => {
    expect(toggleInSelection(["a", "b"], null, "c")).toEqual({ many: ["a", "b", "c"], single: null });
    expect(toggleInSelection(["a", "b", "c"], null, "b")).toEqual({ many: ["a", "c"], single: null });
    expect(toggleInSelection(["a", "b"], null, "a")).toEqual({ many: [], single: "b" });
  });

  it("selects a card alone when nothing else was, and keeps it on a second modified click", () => {
    expect(toggleInSelection([], null, "a")).toEqual({ many: [], single: "a" });
    expect(toggleInSelection([], "a", "a")).toEqual({ many: [], single: "a" });
  });
});

describe("areasLeft", () => {
  it("names each area the agents leave once, an unnamed one by the placeholder", () => {
    const areas = [
      { id: "x", label: "Design", x: 0, y: 0, members: ["a", "b"] },
      { id: "y", label: " ", x: 0, y: 0, members: ["c"] },
      { id: "z", label: "Other", x: 0, y: 0, members: ["d"] },
    ];
    expect(areasLeft(areas, ["a", "b", "c"], "Unnamed area")).toEqual(["Design", "Unnamed area"]);
    expect(areasLeft(areas, ["e"], "Unnamed area")).toEqual([]);
  });
});
