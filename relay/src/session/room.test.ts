import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOM_CONNECTORS_MAX, isConnectorServer, isDescendant, isRoomMembership, liveAncestorId, resolveAgentRef, roomAgentState, roomAreas, takesRoomPlace, titleFromTask, type RoomMembership } from "./room.js";

const worker: RoomMembership = { roomId: "p", role: "worker", parentId: "p", createdBy: "agent", task: "count lines" };
const principal: RoomMembership = { roomId: "p", role: "principal", createdBy: "user", task: "", undeliveredReports: [] };

test("isRoomMembership accepts the two shapes and rejects anything that would confuse the room logic", () => {
  assert.equal(isRoomMembership(worker), true);
  assert.equal(isRoomMembership(principal), true);
  assert.equal(isRoomMembership({ ...worker, queuedMessages: [{ text: "x", at: 1, reminder: true }] }), true);
  assert.equal(isRoomMembership({ ...worker, area: "Code", report: { status: "done", summary: "ok", artifacts: ["a.md"], at: 1 }, stopped: { reason: "user", at: 2 } }), true);

  const rejected: [string, unknown][] = [
    ["not an object", "worker"],
    ["startedAt not a time", { ...worker, startedAt: "now" }],
    ["connectors not strings", { ...worker, connectors: [1] }],
    ["too many connectors", { ...worker, connectors: Array.from({ length: ROOM_CONNECTORS_MAX + 1 }, (_, n) => `s${n}`) }],
    ["no roomId", { ...worker, roomId: "" }],
    ["unknown role", { ...worker, role: "lead" }],
    ["unknown creator", { ...worker, createdBy: "someone" }],
    ["task not a string", { ...worker, task: 3 }],
    ["worker without a parent", { ...worker, parentId: undefined }],
    ["principal with a parent", { ...principal, parentId: "x" }],
    ["worker with an outbox of non-strings", { ...worker, undeliveredReports: [1] }],
    ["outbox of non-strings", { ...principal, undeliveredReports: [1] }],
    ["bad report status", { ...worker, report: { status: "ok", summary: "", artifacts: [], at: 1 } }],
    ["report without artifacts", { ...worker, report: { status: "done", summary: "", at: 1 } }],
    ["bad stop reason", { ...worker, stopped: { reason: "bored", at: 1 } }],
    ["negative timestamp", { ...worker, stopped: { reason: "user", at: -1 } }],
    ["area not a string", { ...worker, area: 1 }],
    ["queued reminder flag not true", { ...worker, queuedMessages: [{ text: "x", at: 1, reminder: "yes" }] }],
    ["purpose not a string", { ...worker, purpose: 1 }],
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

test("an agent waiting for the person shows as such, below a running turn and above its queue and report", () => {
  const done = { ...worker, report: { status: "done" as const, summary: "", artifacts: [], at: 1 } };
  assert.equal(roomAgentState(worker, false, true), "awaiting_user");
  assert.equal(roomAgentState(done, false, true), "awaiting_user");
  assert.equal(roomAgentState({ ...worker, queuedMessages: [{ text: "go", at: 1 }] }, false, true), "awaiting_user");
  assert.equal(roomAgentState(worker, true, true), "working");
  assert.equal(roomAgentState({ ...worker, stopped: { reason: "user", at: 1 } }, false, true), "stopped");
  assert.equal(takesRoomPlace("awaiting_user"), false);
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

test("a worker's outbox validates like a principal's", () => {
  assert.equal(isRoomMembership({ ...worker, undeliveredReports: ["c1"] }), true);
});

test("liveAncestorId skips stopped agents and ones that are gone, up to the principal", () => {
  const rooms: Record<string, RoomMembership> = {
    p: principal,
    a: { ...worker, parentId: "p" },
    b: { ...worker, parentId: "a" },
    c: { ...worker, parentId: "b" },
    loop1: { ...worker, parentId: "loop2" },
    loop2: { ...worker, parentId: "loop1", stopped: { reason: "user", at: 1 } },
  };
  const get = (id: string): RoomMembership | undefined => rooms[id];
  assert.equal(liveAncestorId("c", get), "b");
  assert.equal(liveAncestorId("a", get), "p");
  rooms.b = { ...rooms.b, stopped: { reason: "user", at: 1 } };
  assert.equal(liveAncestorId("c", get), "a", "the stopped parent is skipped");
  rooms.a = { ...rooms.a, stopped: { reason: "removed", at: 1 } };
  assert.equal(liveAncestorId("c", get), "p");
  delete rooms.a;
  assert.equal(liveAncestorId("c", get), undefined, "a chain broken by a missing agent has no live ancestor");
  assert.equal(liveAncestorId("loop1", get), undefined, "a cycle ends the walk");
  assert.equal(liveAncestorId("p", get), undefined);
});

test("contextSeenAt is a timestamp or absent", () => {
  const base = { roomId: "r", role: "principal", createdBy: "user", task: "" };
  assert.equal(isRoomMembership({ ...base, contextSeenAt: 1700000000000 }), true);
  assert.equal(isRoomMembership({ ...base, contextSeenAt: "soon" }), false);
  assert.equal(isRoomMembership({ ...base, contextSeenAt: -1 }), false);
});

test("the clock and the connectors of an agent are part of its persisted record", () => {
  assert.equal(isRoomMembership({ ...worker, startedAt: 5, connectors: ["figma", "linear"] }), true);
});

test("the relay's own MCP bridges are not connectors", () => {
  for (const own of ["anywh-choice", "anywh-room", "anywh-permission", ""]) assert.equal(isConnectorServer(own), false, own);
  for (const server of ["figma", "claude_ai_Linear", "my-server"]) assert.equal(isConnectorServer(server), true, server);
});

test("resolveAgentRef finds an agent by id, by name whatever its case, or by the start of its id", () => {
  const agents = [
    { id: "5aac1c53-0000-4000-8000-000000000001", title: "Slack" },
    { id: "5aac9999-0000-4000-8000-000000000002", title: "Pricing research" },
    { id: "77777777-0000-4000-8000-000000000003", title: "Pricing research" },
    { id: "88888888-0000-4000-8000-000000000004", title: null },
  ];
  assert.deepEqual(resolveAgentRef("5aac1c53-0000-4000-8000-000000000001", agents), { id: agents[0].id });
  assert.deepEqual(resolveAgentRef("  slack ", agents), { id: agents[0].id });
  assert.deepEqual(resolveAgentRef("5aac1c53", agents), { id: agents[0].id });
  assert.deepEqual(resolveAgentRef("5aac", agents), { error: "unknown" }, "too short a prefix is not taken for an id");
  assert.deepEqual(resolveAgentRef("pricing research", agents), { error: "ambiguous", ids: [agents[1].id, agents[2].id] });
  assert.deepEqual(resolveAgentRef("Design", agents), { error: "unknown" });
});

test("roomAreas takes the canvas's areas, the empty ones the person drew included, and an agent not laid out yet in the area it was given", () => {
  const { areas, areaOf } = roomAreas(
    [
      { label: "Inbox", members: ["a", "gone"] },
      { label: "  Later ", members: [] },
      { label: "", members: ["b"] },
    ],
    [{ id: "a", area: "Research" }, { id: "b" }, { id: "c", area: " inbox" }, { id: "d", area: "Pricing" }, { id: "e" }],
  );
  assert.deepEqual(areas, [
    { name: "Inbox", agentIds: ["a", "c"] },
    { name: "Later", agentIds: [] },
    { name: "Pricing", agentIds: ["d"] },
  ]);
  assert.equal(areaOf.get("a"), "Inbox", "the canvas wins over the area it was delegated to: the person moved it");
  assert.equal(areaOf.get("c"), "Inbox", "matched by label whatever its case and spacing, as the client does");
  assert.equal(areaOf.has("b"), false);
  assert.equal(areaOf.has("e"), false, "an agent can be in no area");
});
