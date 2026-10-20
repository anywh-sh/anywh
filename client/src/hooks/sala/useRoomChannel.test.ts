import { describe, expect, it } from "vitest";
import { reduceRoomChannel, type RoomChannelState } from "@/hooks/sala/useRoomChannel";
import type { RoomAgent, RoomSummary } from "@/lib/relay/roomClient";

const summary = (working: number): RoomSummary => ({
  counts: { working, awaiting_user: 0, queued: 0, waiting: 0, done: 0, blocked: 0, failed: 0, stopped: 0 },
  needsYou: 0,
  live: working,
  liveLimit: 10,
});

function agent(agentId: string, over: Partial<RoomAgent> = {}): RoomAgent {
  return { agentId, role: "worker", parentId: "main", title: agentId, runtime: "claude", model: null, createdBy: "agent", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, ...over };
}

const start: RoomChannelState = { status: "connecting", agents: [], summary: null, since: new Map() };

describe("reduceRoomChannel", () => {
  it("takes the snapshot whole, in the order the relay lists it, and opens", () => {
    const next = reduceRoomChannel(start, { type: "room_snapshot", roomId: "r", agents: [agent("main", { role: "principal" }), agent("a")], summary: summary(2) }, 1000);
    expect(next.status).toBe("open");
    expect(next.agents.map((a) => a.agentId)).toEqual(["main", "a"]);
    expect(next.summary?.counts.working).toBe(2);
  });

  it("replaces one agent in place on a state frame, and appends one it did not know", () => {
    const snap = reduceRoomChannel(start, { type: "room_snapshot", roomId: "r", agents: [agent("main", { role: "principal" }), agent("a"), agent("b")], summary: summary(3) }, 1000);
    const changed = reduceRoomChannel(snap, { type: "room_agent_state", roomId: "r", agent: agent("a", { state: "done" }) }, 2000);
    expect(changed.agents.map((a) => [a.agentId, a.state])).toEqual([["main", "working"], ["a", "done"], ["b", "working"]]);
    const added = reduceRoomChannel(changed, { type: "room_agent_state", roomId: "r", agent: agent("c") }, 3000);
    expect(added.agents.map((a) => a.agentId)).toEqual(["main", "a", "b", "c"]);
  });

  it("drops an agent that was removed, and its clock with it", () => {
    const snap = reduceRoomChannel(start, { type: "room_snapshot", roomId: "r", agents: [agent("main", { role: "principal" }), agent("a")], summary: summary(2) }, 1000);
    const next = reduceRoomChannel(snap, { type: "room_agent_removed", roomId: "r", agentId: "a" }, 2000);
    expect(next.agents.map((a) => a.agentId)).toEqual(["main"]);
    expect(next.since.has("a")).toBe(false);
  });

  it("updates only the totals on a summary frame", () => {
    const snap = reduceRoomChannel(start, { type: "room_snapshot", roomId: "r", agents: [agent("a")], summary: summary(1) }, 1000);
    const next = reduceRoomChannel(snap, { type: "room_summary", roomId: "r", summary: summary(0) }, 2000);
    expect(next.agents).toBe(snap.agents);
    expect(next.summary?.counts.working).toBe(0);
  });

  it("counts an agent's clock from when this screen first saw its state, and restarts it on a change", () => {
    const snap = reduceRoomChannel(start, { type: "room_snapshot", roomId: "r", agents: [agent("a")], summary: summary(1) }, 1000);
    const again = reduceRoomChannel(snap, { type: "room_agent_state", roomId: "r", agent: agent("a", { title: "renamed" }) }, 5000);
    expect(again.since.get("a")).toEqual({ state: "working", since: 1000 });
    const done = reduceRoomChannel(again, { type: "room_agent_state", roomId: "r", agent: agent("a", { state: "done" }) }, 9000);
    expect(done.since.get("a")).toEqual({ state: "done", since: 9000 });
  });

  it("ignores a frame it does not know, or that is not a frame", () => {
    expect(reduceRoomChannel(start, { type: "something_new" }, 1)).toBe(start);
    expect(reduceRoomChannel(start, "text", 1)).toBe(start);
    expect(reduceRoomChannel(start, null, 1)).toBe(start);
  });
});
