// The Codex def's side of the room tools, held against the protocol shapes
// recorded from codex-cli 0.154.0's generated bindings
// (tests/fixtures/codex-app-server-0.154.0-dynamic-tools.json). Nothing here
// ran against a real Codex: if the fixture is regenerated from a newer CLI
// and a shape moved, these fail and say which field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codexRuntimeDef } from "./codex.js";
import type { JsonRpcDaemonPlan, RoomTurnSetup, TurnContext, TurnHost } from "../types.js";

interface Fixture {
  cliVersion: string;
  types: Record<string, string>;
  threadStartParamsFields: string[];
  serverRequestMethods: string[];
  dynamicToolCallItem: string;
}

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../tests/fixtures/codex-app-server-0.154.0-dynamic-tools.json"), "utf8")) as Fixture;
const plan = codexRuntimeDef.exec as JsonRpcDaemonPlan;

/** Field names of one object type body, e.g. `{ a: string, b?: number, }`. */
function fields(body: string): string[] {
  return [...body.matchAll(/(?:^|[{,])\s*"?(\w+)"?\??:/g)].map((match) => match[1]);
}

const room = (role: "principal" | "worker"): RoomTurnSetup => ({
  role,
  instructions: `instructions for the ${role}`,
  tools:
    role === "principal"
      ? [{ name: "delegate", description: "start an agent", inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } }]
      : [{ name: "report", description: "report back", inputSchema: { type: "object", properties: {} } }],
});

const ctx = (extra: Partial<TurnContext> = {}): TurnContext => ({ cwd: "/work", prompt: "go", permissionModeId: "workspace-write", ...extra });

test("the fixture is the recorded 0.154.0 shape and still has what the room tools use", () => {
  assert.equal(fixture.cliVersion, "0.154.0");
  for (const field of ["dynamicTools", "config", "developerInstructions", "cwd"]) assert.ok(fixture.threadStartParamsFields.includes(field), field);
  assert.ok(fixture.serverRequestMethods.includes("item/tool/call"));
});

test("a room agent's thread declares the room tools as dynamic tools, in the recorded shape", () => {
  const spec = plan.thread.start(ctx({ room: room("worker") }));
  assert.equal(spec.method, "thread/start");
  const params = spec.params as Record<string, unknown>;
  for (const key of Object.keys(params)) assert.ok(fixture.threadStartParamsFields.includes(key), `thread/start param ${key} is not in ThreadStartParams`);
  const tools = params.dynamicTools as Record<string, unknown>[];
  assert.equal(tools.length, 1);
  const allowed = new Set(["type", ...fields(fixture.types.DynamicToolFunctionSpec)]);
  for (const tool of tools) {
    for (const key of Object.keys(tool)) assert.ok(allowed.has(key), `dynamic tool key ${key} is not in DynamicToolSpec`);
    assert.equal(tool.type, "function");
    assert.ok(fixture.types.DynamicToolSpec.includes('{ "type": "function" } & DynamicToolFunctionSpec'));
  }
  assert.deepEqual(tools[0], { type: "function", name: "report", description: "report back", inputSchema: { type: "object", properties: {} } });
  assert.equal(params.developerInstructions, "instructions for the worker");
  assert.equal(params.config, undefined, "a worker keeps Codex's own defaults");
});

test("a principal's thread turns Codex's native subagents off, and its turns are read-only whatever the mode", () => {
  const params = plan.thread.start(ctx({ room: room("principal") })).params as Record<string, unknown>;
  // The nested form: the dotted key `features.multi_agent` did not turn it off.
  assert.deepEqual(params.config, { features: { multi_agent: false } });
  for (const mode of ["workspace-write", "full-access", "read-only"]) {
    const turn = plan.turn.start(ctx({ room: room("principal"), permissionModeId: mode }), "thr-1").params as Record<string, unknown>;
    assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false }, mode);
    assert.equal(turn.approvalPolicy, "never", mode);
  }
  const worker = plan.turn.start(ctx({ room: room("worker"), permissionModeId: "full-access" }), "thr-1").params as Record<string, unknown>;
  assert.deepEqual(worker.sandboxPolicy, { type: "dangerFullAccess" }, "a worker keeps its mode");
  const plain = plan.thread.start(ctx()).params as Record<string, unknown>;
  assert.deepEqual(plain, { cwd: "/work" }, "a session outside a room starts exactly as before");
});

test("item/tool/call is answered at once through the room, in the recorded response shape", async () => {
  const calls: unknown[] = [];
  const host: TurnHost = {
    requestApproval: () => Promise.resolve("decline"),
    requestUserInput: () => Promise.resolve("deferred"),
    callRoomTool: (call) => {
      calls.push(call);
      return Promise.resolve({ text: '{"agentId":"a1"}', isError: false });
    },
  };
  const params = { threadId: "thr-1", turnId: "turn-1", callId: "call-1", namespace: null, tool: "delegate", arguments: { task: "x" } };
  assert.deepEqual(Object.keys(params).sort(), fields(fixture.types.DynamicToolCallParams).sort(), "the test's request matches the recorded params");
  const response = (await plan.handleServerRequest("item/tool/call", params, host)) as Record<string, unknown>;
  assert.deepEqual(calls, [{ threadId: "thr-1", turnId: "turn-1", callId: "call-1", tool: "delegate", arguments: { task: "x" } }]);
  assert.deepEqual(Object.keys(response).sort(), fields(fixture.types.DynamicToolCallResponse).sort());
  assert.deepEqual(response, { contentItems: [{ type: "inputText", text: '{"agentId":"a1"}' }], success: true });
  assert.ok(fixture.types.DynamicToolCallOutputContentItem.includes('{ "type": "inputText", text: string, }'));

  const failing: TurnHost = { ...host, callRoomTool: () => Promise.resolve({ text: "limit reached", isError: true }) };
  assert.deepEqual(await plan.handleServerRequest("item/tool/call", params, failing), { contentItems: [{ type: "inputText", text: "limit reached" }], success: false });
});

test("a tool call nobody can answer, or one in an unknown shape, fails visibly to the model instead of hanging", async () => {
  const bare: TurnHost = { requestApproval: () => Promise.resolve("decline"), requestUserInput: () => Promise.resolve("deferred") };
  const params = { threadId: "thr-1", turnId: "turn-1", callId: "c", namespace: null, tool: "delegate", arguments: {} };
  const none = (await plan.handleServerRequest("item/tool/call", params, bare)) as { success: boolean; contentItems: { text: string }[] };
  assert.equal(none.success, false);
  assert.match(none.contentItems[0].text, /room tools are not available/);
  const odd = (await plan.handleServerRequest("item/tool/call", { threadId: "thr-1", name: "delegate" }, { ...bare, callRoomTool: () => Promise.resolve({ text: "", isError: false }) })) as {
    success: boolean;
    contentItems: { text: string }[];
  };
  assert.equal(odd.success, false);
  assert.match(odd.contentItems[0].text, /unexpected shape/);
});

test("a dynamicToolCall item is shown like an MCP call of the room's server", () => {
  assert.ok(fields(fixture.dynamicToolCallItem.replace('"type": "dynamicToolCall",', "")).includes("tool"));
  const item = { type: "dynamicToolCall", id: "call-1", namespace: null, tool: "delegate", arguments: { task: "x" }, status: "inProgress", contentItems: null, success: null, durationMs: null };
  const started = plan.mapNotification("item/started", { threadId: "thr-1", turnId: "turn-1", item }, { turnId: "turn-1" });
  assert.equal(started.length, 1);
  assert.equal(started[0].type, "tool_started");
  assert.deepEqual((started[0] as { subject?: unknown }).subject, { kind: "mcp", server: "anywh-room", tool: "delegate" });
  const done = plan.mapNotification(
    "item/completed",
    { threadId: "thr-1", turnId: "turn-1", item: { ...item, status: "completed", contentItems: [{ type: "inputText", text: '{"agentId":"a1"}' }], success: true } },
    { turnId: "turn-1" },
  );
  assert.equal(done.length, 1);
  assert.equal(done[0].type, "tool_ended");
  assert.equal((done[0] as { content: string }).content, '{"agentId":"a1"}');
  assert.equal((done[0] as { isError: boolean }).isError, false);
});
