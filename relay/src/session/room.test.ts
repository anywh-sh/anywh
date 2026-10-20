import { test } from "node:test";
import assert from "node:assert/strict";
import { isDescendant, isLiveMember, isRoomMembership, titleFromTask, type RoomMembership } from "./room.js";

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

test("a member is live until stopped or done; a blocked one still counts", () => {
  assert.equal(isLiveMember(worker), true);
  assert.equal(isLiveMember({ ...worker, report: { status: "blocked", summary: "", artifacts: [], at: 1 } }), true);
  assert.equal(isLiveMember({ ...worker, report: { status: "done", summary: "", artifacts: [], at: 1 } }), false);
  assert.equal(isLiveMember({ ...worker, report: { status: "failed", summary: "", artifacts: [], at: 1 } }), false);
  assert.equal(isLiveMember({ ...worker, stopped: { reason: "user", at: 1 } }), false);
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
