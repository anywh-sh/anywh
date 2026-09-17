import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionDriver } from "./createSessionDriver.js";
import { claudeRuntimeDef } from "./defs/claude/index.js";
import { codexRuntimeDef } from "./defs/codex.js";
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

test("createSessionDriver: a jsonRpcDaemon def (codexRuntimeDef) resolves to a working driver", () => {
  const driver = createSessionDriver(codexRuntimeDef, { host: noopHost });
  // Same duck-typed check as the spawnPerTurn case above — the point of the
  // interface is that this function's caller never needs to know it got a
  // CodexSessionDriver rather than a ClaudeSessionDriver back.
  assert.equal(typeof driver.sendTurn, "function");
  assert.equal(typeof driver.stop, "function");
  assert.equal(typeof driver.dispose, "function");
  assert.equal(driver.getSessionId(), undefined);
  // rewind is genuinely absent (not a stub that throws) — codexRuntimeDef
  // declares capabilities.rewindTurn: "none".
  assert.equal(typeof driver.rewind, "undefined");
});

test("createSessionDriver: a custom def throws", () => {
  const def: AgentRuntimeDef = { ...claudeRuntimeDef, exec: { kind: "custom", note: "not a real transport" } };
  assert.throws(() => createSessionDriver(def, { host: noopHost }), /custom/);
});
