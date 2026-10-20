import { test } from "node:test";
import assert from "node:assert/strict";
import { isDescendant, isRoomMembership, roomAgentState, takesRoomPlace, titleFromTask, type RoomMembership } from "./room.js";

const worker: RoomMembership = { roomId: "p", role: "worker", parentId: "p", createdBy: "agent", task: "count lines" };
const principal: RoomMembership = { roomId: "p", role: "principal", createdBy: "user", task: "", undeliveredReports: [] };

test("isRoomMembership accepts the two shapes and rejects anything that would confuse the room logic", () => {
  assert.equal(isRoomMembership(worker), true);
  assert.equal(isRoomMembership(principal), true);
  assert.equal(isRoomMembership({ ...worker, area: "Code", report: { status: "done", summary: "ok", artifacts: ["a.md"], at: 1 }, stopped: { reason: "user", at: 2 } }), true);

  const rejected: [string, unknown][] = [
    ["not an object", "worker"],
    ["no roomId", { ...worker, roomId: "" }],
    ["unknown role", { ...worker, role: "lead" }],
    ["unknown creator", { ...worker, createdBy: "someone" }],
    ["task not a string", { ...worker, task: 3 }],
    ["worker without a parent", { ...worker, parentId: undefined }],
    ["principal with a parent", { ...principal, parentId: "x" }],
    ["worker with an outbox", { ...worker, undeliveredReports: [] }],
    ["outbox of non-strings", { ...principal, undeliveredReports: [1] }],
    ["bad report status", { ...worker, report: { status: "ok", summary: "", artifacts: [], at: 1 } }],
    ["report without artifacts", { ...worker, report: { status: "done", summary: "", at: 1 } }],
    ["bad stop reason", { ...worker, stopped: { reason: "bored", at: 1 } }],
    ["negative timestamp", { ...worker, stopped: { reason: "user", at: -1 } }],
    ["area not a string", { ...worker, area: 1 }],
  ];
  for (const [what, value] of rejected) assert.equal(isRoomMembership(value), false, what);
});

test("an agent's state: only one with something running or waiting to run takes a place under the cap", () => {
  const report = (status: "done" | "blocked" | "failed") => ({ status, summary: "", artifacts: [], at: 1 });
  const cases: [RoomMembership, boolean, string, boolean][] = [
    [worker, true, "working", true],
    [worker, false, "waiting", false],
    [{ ...worker, queuedMessages: [{ text: "go", at: 1 }] }, false, "queued", true],
    [{ ...worker, report: report("done") }, false, "done", false],
    [{ ...worker, report: report("blocked") }, false, "blocked", false],
    [{ ...worker, report: report("failed") }, false, "failed", false],
    [{ ...worker, report: report("done") }, true, "working", true],
    [{ ...worker, stopped: { reason: "user", at: 1 } }, true, "stopped", false],
  ];
  for (const [room, busy, state, takes] of cases) {
    assert.equal(roomAgentState(room, busy), state);
    assert.equal(takesRoomPlace(roomAgentState(room, busy)), takes, state);
  }
});

test("queued messages and synthetic reports validate; a principal never has a queue", () => {
  assert.equal(isRoomMembership({ ...worker, queuedMessages: [{ text: "a", at: 1 }], report: { status: "failed", summary: "x", artifacts: [], at: 1, synthetic: true } }), true);
  assert.equal(isRoomMembership({ ...worker, queuedMessages: [{ text: 1, at: 1 }] }), false);
  assert.equal(isRoomMembership({ ...worker, report: { status: "done", summary: "", artifacts: [], at: 1, synthetic: "yes" } }), false);
  assert.equal(isRoomMembership({ ...principal, queuedMessages: [] }), false);
});

test("isDescendant walks the parent chain and survives a cycle", () => {
  const parents: Record<string, string | undefined> = { a: "p", b: "a", c: "b", x: "y", y: "x" };
  const parentOf = (id: string): string | undefined => parents[id];
  assert.equal(isDescendant("a", "p", parentOf), true);
  assert.equal(isDescendant("c", "p", parentOf), true);
  assert.equal(isDescendant("c", "a", parentOf), true);
  assert.equal(isDescendant("a", "c", parentOf), false);
  assert.equal(isDescendant("p", "p", parentOf), false);
  assert.equal(isDescendant("x", "p", parentOf), false);
});

test("titleFromTask takes the first line and cuts long ones at a word", () => {
  assert.equal(titleFromTask("Count the lines of README\nthen report"), "Count the lines of README");
  assert.equal(titleFromTask("   "), "Agent");
  const long = titleFromTask("Investigate why the websocket reconnect loop spins forever when the relay restarts mid turn");
  assert.ok(long.length <= 61, long);
  assert.ok(long.endsWith("…"));
  assert.ok(!long.includes("  "));
});
