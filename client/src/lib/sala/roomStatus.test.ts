import { afterEach, describe, expect, it } from "vitest";
import type { RoomAgent } from "@/lib/relay/roomClient";
import { forgetRoomStatus, isRoomCompleted, publishRoomStatus, resetRoomStatuses, roomStatusOf, totalRoomStatuses } from "@/lib/sala/roomStatus";

function agent(agentId: string, over: Partial<RoomAgent> = {}): RoomAgent {
  return { agentId, role: "worker", parentId: "main", title: agentId, runtime: "claude", model: null, createdBy: "agent", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, connectors: [], ...over };
}
const main = (over: Partial<RoomAgent> = {}) => agent("main", { role: "principal", parentId: undefined, state: "waiting", ...over });

describe("roomStatusOf", () => {
  it("counts what runs, what waits for the person and what failed", () => {
    const status = roomStatusOf([
      main(),
      agent("a"),
      agent("b", { state: "awaiting_user", needsYou: [{ kind: "choice", promptId: "q", count: 1 }] }),
      agent("c", { state: "failed" }),
      agent("d", { state: "done" }),
    ]);
    // The principal reads as running while a worker works.
    expect(status).toMatchObject({ agents: 5, working: 2, needsYou: 1, failed: 1, completed: false });
  });
  it("counts an agent that asked and went on working as waiting only", () => {
    const status = roomStatusOf([main(), agent("a", { state: "working", needsYou: [{ kind: "approval", promptId: "p", count: 2 }] })]);
    expect(status.needsYou).toBe(1);
    expect(status.working).toBe(1);
  });
});

describe("isRoomCompleted", () => {
  it("needs an idle principal and every live worker done", () => {
    expect(isRoomCompleted([main(), agent("a", { state: "done" }), agent("b", { state: "stopped" })])).toBe(true);
    expect(isRoomCompleted([main(), agent("a", { state: "done" }), agent("b", { state: "failed" })])).toBe(false);
    expect(isRoomCompleted([main({ state: "working" }), agent("a", { state: "done" })])).toBe(false);
  });
  it("is not complete before any worker exists", () => {
    expect(isRoomCompleted([main()])).toBe(false);
  });
});

describe("totalRoomStatuses", () => {
  it("adds the rooms up", () => {
    expect(totalRoomStatuses([{ agents: 3, working: 1, needsYou: 2, failed: 0, completed: false }, { agents: 2, working: 0, needsYou: 1, failed: 1, completed: false }])).toEqual({ working: 1, needsYou: 3, failed: 1 });
  });
});

describe("the status store", () => {
  afterEach(() => resetRoomStatuses());
  const status = { agents: 2, working: 1, needsYou: 0, failed: 0, completed: false };

  it("keeps a room's status while anyone still watches it, and drops it with the last one", async () => {
    const { getRoomStatusForTest } = await import("@/lib/sala/roomStatus");
    publishRoomStatus("r", status, "canvas");
    publishRoomStatus("r", status, "probe");
    forgetRoomStatus("r", "canvas");
    expect(getRoomStatusForTest("r")).toEqual(status);
    forgetRoomStatus("r", "probe");
    expect(getRoomStatusForTest("r")).toBeUndefined();
  });
});
