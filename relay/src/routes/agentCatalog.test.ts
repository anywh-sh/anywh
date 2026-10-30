import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeRuntimeDef } from "../runtimes/defs/claude/index.js";
import { codexRuntimeDef } from "../runtimes/defs/codex.js";
import type { AgentDetection } from "../runtimes/detection.js";
import type { AgentRuntimeDef } from "../runtimes/types.js";
import { catalogEntry } from "./agentCatalog.js";

function detection(def: AgentRuntimeDef, installed: boolean, version?: string): AgentDetection {
  return { id: def.identity.id, installed, version, capabilities: def.capabilities };
}

test("catalogEntry: an installed, logged-in agent carries its parsed version, login command and install link", () => {
  assert.deepEqual(catalogEntry(codexRuntimeDef, detection(codexRuntimeDef, true, "codex-cli 0.154.0"), { kind: "status", loggedIn: true }), {
    id: "codex",
    bin: "codex",
    installed: true,
    version: "0.154.0",
    loggedIn: true,
    loginCommand: "codex login",
    installUrl: "https://developers.openai.com/codex/cli",
  });
});

test("catalogEntry: the login command starts with the binary's file name, never its full path", () => {
  const def = { ...claudeRuntimeDef, identity: { ...claudeRuntimeDef.identity, bin: "/home/someone/.local/bin/claude" } };
  const entry = catalogEntry(def, detection(def, true, "2.1.303 (Claude Code)"), { kind: "status", loggedIn: false });
  assert.equal(entry.bin, "claude");
  assert.equal(entry.loginCommand, "claude auth login");
  assert.equal(entry.loggedIn, false);
});

test("catalogEntry: a missing agent has no version and no login state, but keeps its install link", () => {
  const entry = catalogEntry(codexRuntimeDef, detection(codexRuntimeDef, false), undefined);
  assert.equal(entry.installed, false);
  assert.equal(entry.version, null);
  assert.equal(entry.loggedIn, null);
  assert.equal(entry.installUrl, "https://developers.openai.com/codex/cli");
});

test("catalogEntry: a failed probe reads as logged out, an unprobable one as unknown", () => {
  const installed = detection(codexRuntimeDef, true, "codex-cli 0.154.0");
  assert.equal(catalogEntry(codexRuntimeDef, installed, { kind: "failed" }).loggedIn, false);
  assert.equal(catalogEntry(codexRuntimeDef, installed, { kind: "unprobable" }).loggedIn, null);
});

test("catalogEntry: a version line with nothing version-shaped is null, and a def without links answers null", () => {
  const bare: AgentRuntimeDef = { ...codexRuntimeDef, identity: { ...codexRuntimeDef.identity, install: undefined }, auth: { kind: "none" } };
  const entry = catalogEntry(bare, detection(bare, true, "dev build"), { kind: "status", loggedIn: true });
  assert.equal(entry.version, null);
  assert.equal(entry.loginCommand, null);
  assert.equal(entry.installUrl, null);
});
