import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCoherent } from "../registry.js";
import { codexRuntimeDef } from "./codex.js";
import type { TurnContext } from "../types.js";

function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return { cwd: "/tmp/project", prompt: "hi", permissionModeId: "workspace-write", ...overrides };
}

test("codexRuntimeDef is coherent", () => {
  assert.deepEqual(assertCoherent(codexRuntimeDef), []);
});

test("exec.thread.start: builds a minimal ThreadStartParams (cwd only — everything else is optional)", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  assert.deepEqual(codexRuntimeDef.exec.thread.start(turnContext()), { method: "thread/start", params: { cwd: "/tmp/project" } });
});

test("exec.turn.start: threadId comes from the engine, not TurnContext; prompt becomes a UserInput text block", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const spec = codexRuntimeDef.exec.turn.start(turnContext({ prompt: "list the files" }), "thread-123");
  assert.deepEqual(spec, {
    method: "turn/start",
    params: { threadId: "thread-123", input: [{ type: "text", text: "list the files", text_elements: [] }] },
  });
});

test("exec.turn.interrupt: builds turn/interrupt with both ids as params, not just a method name", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  assert.deepEqual(codexRuntimeDef.exec.turn.interrupt("thread-123", "turn-456"), {
    method: "turn/interrupt",
    params: { threadId: "thread-123", turnId: "turn-456" },
  });
});

test("exec.mapNotification: delegates to mapCodexNotification (real item mapping, not a stub)", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const events = codexRuntimeDef.exec.mapNotification("item/completed", { item: { type: "agentMessage", id: "i1", text: "hi there" } }, { turnId: "t1" });
  assert.deepEqual(events, [{ type: "text", text: "hi there" }]);
});

test("permissions.modesFor: workspace-write is absent on win32, present everywhere else; the default survives on both", () => {
  const linuxModes = codexRuntimeDef.permissions.modesFor("linux").map((mode) => mode.id);
  assert.deepEqual(linuxModes, ["read-only", "workspace-write", "full-access"]);
  const win32Modes = codexRuntimeDef.permissions.modesFor("win32").map((mode) => mode.id);
  assert.deepEqual(win32Modes, ["read-only", "full-access"]);
});

// ---- handleServerRequest: item/commandExecution/requestApproval ----------

test("handleServerRequest (command approval): a real command builds a readable summary and passes availableDecisions through", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: (request: unknown) => {
      captured = request;
      return Promise.resolve("accept");
    },
    requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
  };
  const result = await codexRuntimeDef.exec.handleServerRequest(
    "item/commandExecution/requestApproval",
    { kind: "command", command: "rm -rf build", reason: "cleanup", availableDecisions: ["accept", "decline"] },
    host,
  );
  assert.deepEqual(captured, {
    id: (captured as { id: string }).id,
    summary: "Codex wants to run: rm -rf build (cleanup)",
    detail: { kind: "command", text: "rm -rf build", reason: "cleanup" },
    availableDecisions: [
      { id: "accept", labelKey: "codex.decision.accept" },
      { id: "decline", labelKey: "codex.decision.decline" },
    ],
    safeDecisionId: "decline",
  });
  assert.deepEqual(result, { decision: "accept" });
});

test("handleServerRequest (command approval): a null availableDecisions falls back to the base four-decision set", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: (request: unknown) => {
      captured = request;
      return Promise.resolve("cancel");
    },
    requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
  };
  await codexRuntimeDef.exec.handleServerRequest("item/commandExecution/requestApproval", { command: "ls" }, host);
  assert.deepEqual((captured as { availableDecisions: { id: string }[] }).availableDecisions.map((d) => d.id), [
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
  ]);
  assert.equal((captured as { safeDecisionId: string }).safeDecisionId, "cancel");
});

test("handleServerRequest (command approval): the two amendment-carrying decision variants are filtered out, not guessed at", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: (request: unknown) => {
      captured = request;
      return Promise.resolve("accept");
    },
    requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
  };
  await codexRuntimeDef.exec.handleServerRequest(
    "item/commandExecution/requestApproval",
    { command: "curl example.com", availableDecisions: ["accept", { applyNetworkPolicyAmendment: {} }, "decline"] },
    host,
  );
  assert.deepEqual((captured as { availableDecisions: { id: string }[] }).availableDecisions.map((d) => d.id), ["accept", "decline"]);
});

test("handleServerRequest (command approval): no command text and no commandActions falls back to a readable placeholder", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: (request: unknown) => {
      captured = request;
      return Promise.resolve("decline");
    },
    requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
  };
  await codexRuntimeDef.exec.handleServerRequest("item/commandExecution/requestApproval", {}, host);
  assert.equal((captured as { summary: string }).summary, "Codex wants to run: (no command text)");
});

// ---- handleServerRequest: item/fileChange/requestApproval -----------------

test("handleServerRequest (file-change approval): always offers the fixed base decisions, safe default is cancel", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: (request: unknown) => {
      captured = request;
      return Promise.resolve("accept");
    },
    requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
  };
  const result = await codexRuntimeDef.exec.handleServerRequest(
    "item/fileChange/requestApproval",
    { reason: "extra write access", grantRoot: "/tmp/project/build" },
    host,
  );
  assert.deepEqual(captured, {
    id: (captured as { id: string }).id,
    summary: "Codex wants to change files under /tmp/project/build (extra write access)",
    detail: { kind: "fileChange", text: "/tmp/project/build", reason: "extra write access" },
    availableDecisions: [
      { id: "accept", labelKey: "codex.decision.accept" },
      { id: "acceptForSession", labelKey: "codex.decision.acceptForSession" },
      { id: "decline", labelKey: "codex.decision.decline" },
      { id: "cancel", labelKey: "codex.decision.cancel" },
    ],
    safeDecisionId: "cancel",
  });
  assert.deepEqual(result, { decision: "accept" });
});

// ---- handleServerRequest: item/tool/requestUserInput -----------------------

test("handleServerRequest (user input): a question with real options translates to a real multiple-choice UserInputQuestion", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: () => Promise.reject(new Error("not exercised in this test")),
    requestUserInput: (questions: unknown) => {
      captured = questions;
      return Promise.resolve([{ questionId: "q1", values: ["staging"] }]);
    },
  };
  const result = await codexRuntimeDef.exec.handleServerRequest(
    "item/tool/requestUserInput",
    {
      questions: [
        { id: "q1", header: "Environment", question: "Which environment?", isSecret: false, options: [{ label: "staging", description: "" }] },
      ],
    },
    host,
  );
  assert.deepEqual(captured, [{ id: "q1", header: "Environment", question: "Which environment?", options: [{ label: "staging", description: "" }], secret: false }]);
  assert.deepEqual(result, { answers: { q1: { answers: ["staging"] } } });
});

test("handleServerRequest (user input): null options translates to no options at all — free text, not an empty list forced on the client", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: () => Promise.reject(new Error("not exercised in this test")),
    requestUserInput: (questions: unknown) => {
      captured = questions;
      return Promise.resolve([{ questionId: "q1", values: ["a secret value"] }]);
    },
  };
  await codexRuntimeDef.exec.handleServerRequest(
    "item/tool/requestUserInput",
    { questions: [{ id: "q1", header: "", question: "What's the API key?", isSecret: true, options: null }] },
    host,
  );
  assert.deepEqual(captured, [{ id: "q1", header: undefined, question: "What's the API key?", options: undefined, secret: true }]);
});

test("handleServerRequest (user input): a \"deferred\" host response becomes an empty answers map, not a throw", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const host = {
    requestApproval: () => Promise.reject(new Error("not exercised in this test")),
    requestUserInput: () => Promise.resolve("deferred" as const),
  };
  const result = await codexRuntimeDef.exec.handleServerRequest(
    "item/tool/requestUserInput",
    { questions: [{ id: "q1", header: "", question: "?", isSecret: false, options: null }] },
    host,
  );
  assert.deepEqual(result, { answers: {} });
});

test("handleServerRequest: an unrecognized method returns undefined, so the connection answers method-not-found itself", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const host = { requestApproval: () => Promise.reject(new Error("n/a")), requestUserInput: () => Promise.reject(new Error("n/a")) };
  assert.equal(codexRuntimeDef.exec.handleServerRequest("some/futureMethod", {}, host), undefined);
});

test("handleServerRequest: item/permissions/requestApproval, mcpServer/elicitation/request and item/tool/call are real Codex methods but out of scope — also fall through to undefined", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const host = { requestApproval: () => Promise.reject(new Error("n/a")), requestUserInput: () => Promise.reject(new Error("n/a")) };
  for (const method of ["item/permissions/requestApproval", "mcpServer/elicitation/request", "item/tool/call"]) {
    assert.equal(codexRuntimeDef.exec.handleServerRequest(method, {}, host), undefined);
  }
});
