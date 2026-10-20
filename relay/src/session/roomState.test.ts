import { test } from "node:test";
import assert from "node:assert/strict";
import type { RoomAgentState } from "./room.js";
import { summarizeRoom, type RoomAgentView } from "./roomState.js";

const view = (state: RoomAgentState, needsYou: RoomAgentView["needsYou"] = []): RoomAgentView => ({
  agentId: `a-${Math.random()}`,
  role: "worker",
  title: null,
  runtime: "claude",
  model: null,
  createdBy: "agent",
  state,
  queuedMessages: 0,
  needsYou,
  subtasksRunning: 0,
});
const ask = { kind: "approval" as const, promptId: "p", count: 1 };

test("the summary counts every state, the agents waiting for the person, and the places taken", () => {
  const summary = summarizeRoom([view("working"), view("working", [ask]), view("awaiting_user", [ask]), view("queued"), view("done"), view("failed"), view("stopped")]);
  assert.deepEqual(summary.counts, { working: 2, awaiting_user: 1, queued: 1, waiting: 0, done: 1, blocked: 0, failed: 1, stopped: 1 });
  assert.equal(summary.needsYou, 2, "a working agent that already asked something else still counts");
  assert.equal(summary.live, 3, "working and queued hold a place; waiting for the person does not");
  assert.equal(summary.liveLimit, 10);
});

test("an empty room has every count at zero", () => {
  const summary = summarizeRoom([]);
  assert.ok(Object.values(summary.counts).every((n) => n === 0));
  assert.equal(summary.needsYou, 0);
});
