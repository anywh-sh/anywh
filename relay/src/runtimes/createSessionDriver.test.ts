import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionDriver } from "./createSessionDriver.js";
import { claudeRuntimeDef } from "./defs/claude/index.js";
import type { AgentRuntimeDef } from "./types.js";
import type { SessionDriverHost } from "./sessionDriver.js";

const noopHost: SessionDriverHost = {
  presentChoice: () => false,
  checkPermission: () => Promise.reject(new Error("not exercised in this test")),
  requestApproval: () => Promise.reject(new Error("not exercised in this test")),
  requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
};

test("createSessionDriver: a spawnPerTurn def (claudeRuntimeDef) resolves to a working driver", () => {
  const driver = createSessionDriver(claudeRuntimeDef, { host: noopHost });
  // Duck-typed rather than instanceof ClaudeSessionDriver — the point of
  // the AgentSessionDriver interface is that a caller never needs to know
  // the concrete class, only that it satisfies the contract.
  assert.equal(typeof driver.sendTurn, "function");
  assert.equal(typeof driver.stop, "function");
  assert.equal(typeof driver.dispose, "function");
  assert.equal(driver.getSessionId(), undefined);
});

test("createSessionDriver: a jsonRpcDaemon def throws — Codex's driver isn't wired in yet", () => {
  const def: AgentRuntimeDef = {
    ...claudeRuntimeDef,
    exec: {
      kind: "jsonRpcDaemon",
      framing: "ndjson",
      thread: { start: () => ({ method: "thread/start", params: {} }) },
      turn: { start: () => ({ method: "turn/start", params: {} }), interrupt: () => ({ method: "turn/interrupt", params: {} }) },
      mapNotification: () => [],
      handleServerRequest: () => undefined,
    },
  };
  assert.throws(() => createSessionDriver(def, { host: noopHost }), /jsonRpcDaemon/);
});

test("createSessionDriver: a custom def throws", () => {
  const def: AgentRuntimeDef = { ...claudeRuntimeDef, exec: { kind: "custom", note: "not a real transport" } };
  assert.throws(() => createSessionDriver(def, { host: noopHost }), /custom/);
});
