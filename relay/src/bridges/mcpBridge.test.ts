import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CHOICE_ALLOWED_TOOL,
  CHOICE_ALREADY_PENDING_TEXT,
  CHOICE_DEFERRED_RESPONSE_TEXT,
  McpChoiceBridge,
  type ChoiceQuestion,
} from "./mcpBridge.js";

/** Minimal fakes for the two Node HTTP objects `handleRequest` touches — no
 * real socket needed, `readJsonBody` only uses the `data`/`end`/`error`
 * events. Safe to `emit` right after calling `handleRequest` (not after
 * `await`ing it): an async function runs synchronously up to its first
 * `await`, and `readJsonBody`'s `req.on(...)` calls all happen before that
 * point, so the listeners are already attached by the time `handleRequest`
 * yields control back to the caller. */
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

/** Returns the mutable `state` separately from the `ServerResponse`-typed
 * `res` passed to `handleRequest` — `writableEnded`/`destroyed` are readonly
 * on the real type, so a test that needs to flip them (simulating the
 * connection dying mid-wait) mutates `state` directly instead of casting
 * around TS. Both views share the same underlying data. */
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
  const bridge = new McpChoiceBridge();
  const { res, state } = fakeResponse();
  await bridge.handleRequest("no-such-token", fakeRequest({ method: "tools/list", id: 1 }), res);
  assert.equal(state.status, 404);
});

test("non-POST: 405", async () => {
  const bridge = new McpChoiceBridge();
  const { token } = bridge.registerTurn({ presentChoice: () => true });
  const { res, state } = fakeResponse();
  await bridge.handleRequest(token, fakeRequest({}, "GET"), res);
  assert.equal(state.status, 405);
});

test("initialize: echoes the client's protocolVersion, reports the tool capability", async () => {
  const bridge = new McpChoiceBridge();
  const { token } = bridge.registerTurn({ presentChoice: () => true });
  const { res, state } = fakeResponse();
  await bridge.handleRequest(token, fakeRequest({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2099-01-01" } }), res);
  const body = parsedBody(state);
  assert.equal(body.id, 0);
  assert.equal((body.result as { protocolVersion?: string }).protocolVersion, "2099-01-01");
  assert.deepEqual((body.result as { capabilities?: unknown }).capabilities, { tools: {} });
});

test("notifications/initialized (no id): 202, empty body — never touches the host", async () => {
  const bridge = new McpChoiceBridge();
  const { token } = bridge.registerTurn({ presentChoice: () => true });
  const { res, state } = fakeResponse();
  await bridge.handleRequest(token, fakeRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), res);
  assert.equal(state.status, 202);
  assert.equal(state.body, undefined);
});

test("tools/list: exposes exactly the present_choice tool, matching CHOICE_ALLOWED_TOOL's name", async () => {
  const bridge = new McpChoiceBridge();
  const { token } = bridge.registerTurn({ presentChoice: () => true });
  const { res, state } = fakeResponse();
  await bridge.handleRequest(token, fakeRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), res);
  const body = parsedBody(state);
  const tools = (body.result as { tools?: { name: string }[] }).tools ?? [];
  assert.equal(tools.length, 1);
  assert.equal(`mcp__anywh-choice__${tools[0].name}`, CHOICE_ALLOWED_TOOL);
});

test("tools/call present_choice: forwards questions to the host, replies immediately with the end-turn instruction (deferred lifecycle)", async () => {
  const bridge = new McpChoiceBridge();
  const questions: ChoiceQuestion[] = [{ question: "SQLite or Postgres?", options: [{ label: "SQLite" }, { label: "Postgres" }] }];
  let receivedQuestions: ChoiceQuestion[] | undefined;
  const { token } = bridge.registerTurn({
    presentChoice: (q) => {
      receivedQuestions = q;
      return true;
    },
  });
  const { res, state } = fakeResponse();
  await bridge.handleRequest(
    token,
    fakeRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "present_choice", arguments: { questions } } }),
    res,
  );
  assert.deepEqual(receivedQuestions, questions);
  const body = parsedBody(state);
  const content = (body.result as { content?: { type: string; text: string }[] }).content ?? [];
  assert.equal(content[0].text, CHOICE_DEFERRED_RESPONSE_TEXT);
  assert.equal((body.result as { isError?: boolean }).isError, undefined);
});

test("tools/call present_choice: a second call while one is still pending is rejected with isError, doesn't touch the first", async () => {
  const bridge = new McpChoiceBridge();
  let calls = 0;
  const { token } = bridge.registerTurn({
    presentChoice: () => {
      calls += 1;
      // First call is accepted, every call after it is rejected — mirrors
      // `SharedSession.presentChoice`'s real "only one at a time" behavior
      // without needing `SharedSession` itself in this unit test.
      return calls === 1;
    },
  });
  const { res: res1, state: state1 } = fakeResponse();
  await bridge.handleRequest(
    token,
    fakeRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "present_choice", arguments: { questions: [] } } }),
    res1,
  );
  const body1 = parsedBody(state1);
  assert.equal((body1.result as { content?: { text: string }[] }).content?.[0].text, CHOICE_DEFERRED_RESPONSE_TEXT);

  const { res: res2, state: state2 } = fakeResponse();
  await bridge.handleRequest(
    token,
    fakeRequest({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "present_choice", arguments: { questions: [] } } }),
    res2,
  );
  const body2 = parsedBody(state2);
  assert.equal((body2.result as { isError?: boolean }).isError, true);
  assert.equal((body2.result as { content?: { text: string }[] }).content?.[0].text, CHOICE_ALREADY_PENDING_TEXT);
});

test("resolving after the connection already ended doesn't throw or double-write (defensive — presentChoice is synchronous today, but sendJson's guard predates that)", async () => {
  const bridge = new McpChoiceBridge();
  const { token } = bridge.registerTurn({ presentChoice: () => true });
  const { res, state } = fakeResponse();
  // Simulates the connection already being gone (e.g. the `claude` child
  // got SIGINT'd) by the time `sendJson` would write to it.
  state.writableEnded = true;
  await bridge.handleRequest(
    token,
    fakeRequest({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "present_choice", arguments: { questions: [] } } }),
    res,
  );
  assert.equal(state.body, undefined, "sendJson must have no-op'd, not tried to write to the dead connection");
});

test("unrecognized method with an id: empty result instead of hanging or erroring (e.g. the server/discover preflight)", async () => {
  const bridge = new McpChoiceBridge();
  const { token } = bridge.registerTurn({ presentChoice: () => true });
  const { res, state } = fakeResponse();
  await bridge.handleRequest(token, fakeRequest({ jsonrpc: "2.0", id: 7, method: "server/discover" }), res);
  const body = parsedBody(state);
  assert.equal(body.id, 7);
  assert.deepEqual(body.result, {});
});
