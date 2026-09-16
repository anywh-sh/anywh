import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpPermissionBridge, PERMISSION_PROMPT_TOOL, type PermissionDecision } from "./permissionBridge.js";

/** Same fakes as `mcpBridge.test.ts` — see that file for why this is safe
 * without a real socket. */
function fakeRequest(body: unknown, method = "POST"): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  req.method = method;
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

interface FakeResponseState {
  writableEnded: boolean;
  destroyed: boolean;
  status?: number;
  body?: string;
}

function fakeResponse(): { res: ServerResponse; state: FakeResponseState } {
  const state: FakeResponseState = { writableEnded: false, destroyed: false };
  const res = {
    get writableEnded() {
      return state.writableEnded;
    },
    get destroyed() {
      return state.destroyed;
    },
    writeHead(status: number) {
      state.status = status;
      return res;
    },
    end(chunk?: string) {
      state.writableEnded = true;
      if (chunk !== undefined) state.body = chunk;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

function parsedBody(state: FakeResponseState): { id?: unknown; result?: Record<string, unknown> } {
  return JSON.parse(state.body ?? "{}") as { id?: unknown; result?: Record<string, unknown> };
}

test("unknown token: 404, never reaches any host", async () => {
  const bridge = new McpPermissionBridge();
  const { res, state } = fakeResponse();
  await bridge.handleRequest("no-such-token", fakeRequest({ method: "tools/list", id: 1 }), res);
  assert.equal(state.status, 404);
});

test("non-POST: 405", async () => {
  const bridge = new McpPermissionBridge();
  const { token } = bridge.registerTurn({ checkPermission: async () => ({ behavior: "allow", updatedInput: {} }) });
  const { res, state } = fakeResponse();
  await bridge.handleRequest(token, fakeRequest({}, "GET"), res);
  assert.equal(state.status, 405);
});

test("tools/list: exposes exactly the approve tool, matching PERMISSION_PROMPT_TOOL's name", async () => {
  const bridge = new McpPermissionBridge();
  const { token } = bridge.registerTurn({ checkPermission: async () => ({ behavior: "allow", updatedInput: {} }) });
  const { res, state } = fakeResponse();
  await bridge.handleRequest(token, fakeRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), res);
  const body = parsedBody(state);
  const tools = (body.result as { tools?: { name: string }[] }).tools ?? [];
  assert.equal(tools.length, 1);
  assert.equal(`mcp__anywh-permission__${tools[0].name}`, PERMISSION_PROMPT_TOOL);
});

test("tools/call approve: forwards tool_name/input/tool_use_id to the host, returns its decision as JSON text", async () => {
  const bridge = new McpPermissionBridge();
  const decision: PermissionDecision = { behavior: "allow", updatedInput: { file_path: "/tmp/x" } };
  let received: { toolName: string; input: unknown; toolUseId: string | undefined } | undefined;
  const { token } = bridge.registerTurn({
    checkPermission: async (toolName, input, toolUseId) => {
      received = { toolName, input, toolUseId };
      return decision;
    },
  });
  const { res, state } = fakeResponse();
  await bridge.handleRequest(
    token,
    fakeRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Write", input: { file_path: "/tmp/x" }, tool_use_id: "abc" } },
    }),
    res,
  );
  assert.deepEqual(received, { toolName: "Write", input: { file_path: "/tmp/x" }, toolUseId: "abc" });
  const body = parsedBody(state);
  const content = (body.result as { content?: { type: string; text: string }[] }).content ?? [];
  assert.deepEqual(JSON.parse(content[0].text), decision);
});

test("tools/call approve: a deny decision round-trips just like an allow one", async () => {
  const bridge = new McpPermissionBridge();
  const decision: PermissionDecision = { behavior: "deny", message: "user chose to stay in plan mode" };
  const { token } = bridge.registerTurn({ checkPermission: async () => decision });
  const { res, state } = fakeResponse();
  await bridge.handleRequest(
    token,
    fakeRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "approve", arguments: { tool_name: "ExitPlanMode", input: {} } } }),
    res,
  );
  const body = parsedBody(state);
  const content = (body.result as { content?: { type: string; text: string }[] }).content ?? [];
  assert.deepEqual(JSON.parse(content[0].text), decision);
});

test("tools/call approve: a host that never resolves genuinely blocks the response (no timeout of our own)", async () => {
  const bridge = new McpPermissionBridge();
  let releaseHost: (() => void) | undefined;
  const { token } = bridge.registerTurn({
    checkPermission: () =>
      new Promise((resolve) => {
        releaseHost = () => resolve({ behavior: "allow", updatedInput: {} });
      }),
  });
  const { res, state } = fakeResponse();
  const pending = bridge.handleRequest(
    token,
    fakeRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "approve", arguments: { tool_name: "ExitPlanMode", input: {} } } }),
    res,
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(state.writableEnded, false, "must still be waiting — no response written yet");
  releaseHost?.();
  await pending;
  assert.equal(state.writableEnded, true);
});

test("resolving after the connection already ended doesn't throw or double-write", async () => {
  const bridge = new McpPermissionBridge();
  let releaseHost: (() => void) | undefined;
  const { token } = bridge.registerTurn({
    checkPermission: () =>
      new Promise((resolve) => {
        releaseHost = () => resolve({ behavior: "allow", updatedInput: {} });
      }),
  });
  const { res, state } = fakeResponse();
  const pending = bridge.handleRequest(
    token,
    fakeRequest({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "approve", arguments: { tool_name: "ExitPlanMode", input: {} } } }),
    res,
  );
  await new Promise((r) => setTimeout(r, 20));
  state.writableEnded = true;
  assert.doesNotThrow(() => releaseHost?.());
  await pending;
  assert.equal(state.body, undefined, "sendJson must have no-op'd, not tried to write to the dead connection");
});

test("unrecognized method with an id: empty result instead of hanging or erroring", async () => {
  const bridge = new McpPermissionBridge();
  const { token } = bridge.registerTurn({ checkPermission: async () => ({ behavior: "allow", updatedInput: {} }) });
  const { res, state } = fakeResponse();
  await bridge.handleRequest(token, fakeRequest({ jsonrpc: "2.0", id: 6, method: "server/discover" }), res);
  const body = parsedBody(state);
  assert.equal(body.id, 6);
  assert.deepEqual(body.result, {});
});
