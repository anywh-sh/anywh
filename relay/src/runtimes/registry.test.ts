import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCoherent, buildRegistry } from "./registry.js";
import type { AgentRuntimeDef, Capabilities, HostPlatform, PermissionMode } from "./types.js";

// A minimal but fully coherent def, mutated field-by-field below to
// exercise each assertCoherent check in isolation — the same pattern
// guards.test.ts uses for "accepts valid, rejects one broken field".
const ALL_NONE: Capabilities = {
  presentChoice: "none",
  approvalPrompt: "none",
  rewindTurn: "none",
  replayHistory: "none",
  backgroundJobs: "none",
  thinking: "none",
  contextUsage: "none",
};

const DEFAULT_MODE: PermissionMode<undefined> = { id: "default", labelKey: "mode.default", settings: undefined, pausesForApproval: false };

function baseDef(): AgentRuntimeDef {
  return {
    identity: {
      id: "fixture",
      bin: "fixture-cli",
      env: { strip: ["FIXTURE_API_KEY"] },
      projectInstructionsFile: "AGENTS.md",
    },
    capabilities: ALL_NONE,
    continuity: { kind: "relay-transcript" },
    models: { kind: "static", options: [] },
    auth: { kind: "none" },
    permissions: {
      defaultModeId: "default",
      modesFor: () => [DEFAULT_MODE],
    },
    bridges: [],
    exec: {
      kind: "spawnPerTurn",
      promptDelivery: "argv",
      buildArgs: () => [],
      mapStdoutLine: () => [],
      interrupt: { signal: "SIGINT", expectsCleanExit: true },
    },
  };
}

test("assertCoherent accepts the minimal fixture", () => {
  assert.deepEqual(assertCoherent(baseDef()), []);
});

test("assertCoherent: bridged capability requires the matching bridge", () => {
  const def = baseDef();
  const issues = assertCoherent({ ...def, capabilities: { ...def.capabilities, presentChoice: "bridged" } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /presentChoice.*bridged.*"mcp"/);
});

test("assertCoherent: bridged capability passes once the bridge is declared", () => {
  const def = baseDef();
  const issues = assertCoherent({ ...def, capabilities: { ...def.capabilities, approvalPrompt: "bridged" }, bridges: ["permission"] });
  assert.deepEqual(issues, []);
});

test("assertCoherent: native approvalPrompt requires a jsonRpcDaemon exec plan", () => {
  const def = baseDef();
  const issues = assertCoherent({ ...def, capabilities: { ...def.capabilities, approvalPrompt: "native" } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /server-to-client transport/);
});

test("assertCoherent: every platform needs at least one mode", () => {
  const def = baseDef();
  const issues = assertCoherent({
    ...def,
    permissions: { defaultModeId: "default", modesFor: (platform: HostPlatform) => (platform === "win32" ? [] : [DEFAULT_MODE]) },
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /win32/);
});

test("assertCoherent: defaultModeId must survive on at least one platform", () => {
  const def = baseDef();
  const issues = assertCoherent({ ...def, permissions: { defaultModeId: "ghost", modesFor: () => [DEFAULT_MODE] } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /defaultModeId \("ghost"\)/);
});

test("assertCoherent: defaultModeId is fine if only some platforms carry it (the win32/workspace-write shape)", () => {
  const def = baseDef();
  const modes = [DEFAULT_MODE];
  const issues = assertCoherent({
    ...def,
    permissions: { defaultModeId: "default", modesFor: (platform: HostPlatform) => (platform === "win32" ? [{ ...DEFAULT_MODE, id: "restricted" }] : modes) },
  });
  assert.deepEqual(issues, []);
});

test("assertCoherent: approvalPrompt none is incompatible with a mode that pauses", () => {
  const def = baseDef();
  const pausing: PermissionMode<undefined> = { ...DEFAULT_MODE, pausesForApproval: true };
  const issues = assertCoherent({ ...def, permissions: { defaultModeId: "default", modesFor: () => [pausing] } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /approvalPrompt is "none"/);
});

test("assertCoherent: session-rpc models/auth require a jsonRpcDaemon exec plan", () => {
  const def = baseDef();
  const issues = assertCoherent({ ...def, models: { kind: "session-rpc" } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /session-rpc/);
});

test("assertCoherent: rewindTurn on a jsonRpcDaemon plan requires rewindMethod", () => {
  const def = baseDef();
  const issues = assertCoherent({
    ...def,
    capabilities: { ...def.capabilities, rewindTurn: "native" },
    exec: {
      kind: "jsonRpcDaemon",
      framing: "ndjson",
      thread: { start: () => ({ method: "thread/start", params: {} }) },
      turn: { start: () => ({ method: "turn/start", params: {} }), interruptMethod: "turn/interrupt" },
      mapNotification: () => [],
      handleServerRequest: () => undefined,
    },
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /rewindMethod/);
});

test("assertCoherent: rewindTurn on a spawnPerTurn plan needs no method (it's a relay-side transcript operation)", () => {
  const def = baseDef();
  const issues = assertCoherent({ ...def, capabilities: { ...def.capabilities, rewindTurn: "native" } });
  assert.deepEqual(issues, []);
});

test("assertCoherent: env.strip must not be empty", () => {
  const def = baseDef();
  const issues = assertCoherent({ ...def, identity: { ...def.identity, env: { strip: [] } } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /env\.strip is empty/);
});

// ---------------------------------------------------------------------

test("buildRegistry keeps a coherent def and exposes it by id", () => {
  const registry = buildRegistry([baseDef()]);
  assert.equal(registry.defs.length, 1);
  assert.equal(registry.get("fixture")?.identity.id, "fixture");
  assert.equal(registry.get("missing"), undefined);
});

test("buildRegistry isolates an incoherent def instead of throwing", () => {
  const def = baseDef();
  const broken = { ...def, identity: { ...def.identity, env: { strip: [] } } };
  const originalError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const registry = buildRegistry([baseDef(), broken]);
    assert.equal(registry.defs.length, 1, "the coherent def still made it in");
    assert.equal(registry.get("fixture")?.identity.id, "fixture");
    assert.equal(logged.length, 1);
  } finally {
    console.error = originalError;
  }
});

test("buildRegistry throws on the first incoherent def in strict mode", () => {
  const def = baseDef();
  const broken = { ...def, identity: { ...def.identity, env: { strip: [] } } };
  assert.throws(() => buildRegistry([broken], { strict: true }), /env\.strip is empty/);
});
