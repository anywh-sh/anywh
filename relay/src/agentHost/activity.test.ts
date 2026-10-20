import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateActivity } from "./activity.js";
import type { AgentActivity, AgentState } from "./protocol.js";

function agent(state: AgentState): AgentActivity {
  return { agentId: state, runtime: "claude", state, alive: true, resumable: true, awaitingUser: false, backgroundTasks: 0, createdAt: 0, lastActivityAt: 0, nextOffset: 0 };
}

test("working wins over waiting for the person, which wins over idle", () => {
  assert.equal(aggregateActivity([]), "none");
  assert.equal(aggregateActivity([agent("hibernated"), agent("stopped"), agent("failed"), agent("idle")]), "idle");
  assert.equal(aggregateActivity([agent("idle"), agent("awaiting_user")]), "awaiting_user");
  assert.equal(aggregateActivity([agent("awaiting_user"), agent("starting")]), "working");
  assert.equal(aggregateActivity([agent("awaiting_user"), agent("working")]), "working");
});
