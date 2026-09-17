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

test("handleServerRequest: routes a structured user-input request through the given TurnHost", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const host = {
    requestApproval: () => Promise.reject(new Error("not exercised in this test")),
    requestUserInput: (prompt: string) => Promise.resolve({ text: `answered: ${prompt}` }),
  };
  const result = await codexRuntimeDef.exec.handleServerRequest("item/tool/requestUserInput", { prompt: "which one?" }, host);
  assert.deepEqual(result, { text: "answered: which one?" });
});

test("handleServerRequest: an unrecognized method returns undefined, so the connection answers method-not-found itself", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const host = { requestApproval: () => Promise.reject(new Error("n/a")), requestUserInput: () => Promise.reject(new Error("n/a")) };
  assert.equal(codexRuntimeDef.exec.handleServerRequest("some/futureMethod", {}, host), undefined);
});
