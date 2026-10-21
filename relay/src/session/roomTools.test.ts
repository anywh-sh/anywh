import assert from "node:assert/strict";
import { test } from "node:test";
import { DELEGATE_TOOL, parseDelegateArgs, parseMessageAgentArgs, parseReportArgs, parseStopAgentArgs, parseWorktreeCreateArgs, principalInstructions, roomToolsFor } from "./roomTools.js";

test("only a worker is offered worktree_create; the principal, who changes nothing, is not", () => {
  assert.deepEqual(roomToolsFor("worker").map((tool) => tool.name), ["report", "worktree_create"]);
  assert.ok(!roomToolsFor("principal").some((tool) => tool.name === "worktree_create"));
});

test("worktree_create needs a repo; report takes an integrated flag only as a boolean", () => {
  assert.deepEqual(parseWorktreeCreateArgs({ repo: " ../app " }), { ok: true, value: { repo: "../app" } });
  assert.equal(parseWorktreeCreateArgs({}).ok, false);
  assert.equal(parseWorktreeCreateArgs({ repo: 3 }).ok, false);
  assert.deepEqual(parseReportArgs({ status: "done", summary: "x", integrated: true }), { ok: true, value: { status: "done", summary: "x", artifacts: [], integrated: true } });
  assert.deepEqual(parseReportArgs({ status: "done", summary: "x", integrated: false }), { ok: true, value: { status: "done", summary: "x", artifacts: [] } });
  assert.equal(parseReportArgs({ status: "done", summary: "x", integrated: "yes" }).ok, false);
});

test("delegate asks for a name and a purpose, the area is optional; one without them, from an older tool list or the person, is still taken", () => {
  assert.deepEqual(DELEGATE_TOOL.inputSchema.required, ["name", "purpose", "task", "runtime", "model"]);
  assert.deepEqual(parseDelegateArgs({ name: " Slack ", purpose: "reads Slack channels", task: "read #general", runtime: "Claude", model: "haiku", area: "Research" }), {
    ok: true,
    value: { name: "Slack", purpose: "reads Slack channels", task: "read #general", runtime: "claude", model: "haiku", area: "Research" },
  });
  assert.equal(parseDelegateArgs({ name: "Slack", purpose: "p".repeat(301), task: "x", runtime: "claude", model: "haiku" }).ok, false);
  assert.deepEqual(parseDelegateArgs({ task: "x", runtime: "claude", model: "haiku" }), { ok: true, value: { task: "x", runtime: "claude", model: "haiku" } });
  assert.equal(parseDelegateArgs({ name: "n".repeat(61), task: "x", runtime: "claude", model: "haiku" }).ok, false);
});

test("message_agent takes the agent by name or id, and still takes the agentId field it had before names", () => {
  assert.deepEqual(parseMessageAgentArgs({ agent: "Slack", text: "and #random?" }), { ok: true, value: { agent: "Slack", text: "and #random?" } });
  assert.deepEqual(parseMessageAgentArgs({ agentId: "5aac1c53", text: "hi" }), { ok: true, value: { agent: "5aac1c53", text: "hi" } });
  assert.equal(parseMessageAgentArgs({ text: "hi" }).ok, false);
});

test("the principal is offered stop_agent, told to use it instead of message_agent to interrupt; a worker is not", () => {
  const principal = roomToolsFor("principal");
  assert.deepEqual(principal.map((tool) => tool.name), ["delegate", "message_agent", "stop_agent", "room_status"]);
  assert.ok(!roomToolsFor("worker").some((tool) => tool.name === "stop_agent"));
  assert.match(principal.find((tool) => tool.name === "message_agent")!.description, /does NOT interrupt/);
  assert.match(principalInstructions(["claude"]), /call stop_agent/);
  assert.deepEqual(parseStopAgentArgs({ agent: " Slack " }), { ok: true, value: { agent: "Slack" } });
  assert.deepEqual(parseStopAgentArgs({ agentId: "5aac1c53" }), { ok: true, value: { agent: "5aac1c53" } });
  assert.equal(parseStopAgentArgs({}).ok, false);
});
