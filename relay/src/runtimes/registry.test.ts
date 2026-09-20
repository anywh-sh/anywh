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
    quickPrompt: { kind: "none" },
    exec: {
      kind: "spawnPerTurn",
      promptDelivery: "argv",
      buildArgs: () => [],
      mapStdoutLine: () => [],
      interrupt: { signal: "SIGINT", expectsCleanExit: true },
    },
    portability: { authoredPaths: [".fixture/skills"], mcp: { kind: "none" } },
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
      turn: { start: () => ({ method: "turn/start", params: {} }), interrupt: (threadId, turnId) => ({ method: "turn/interrupt", params: { threadId, turnId } }) },
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

// ---------------------------------------------------------------------
// portability

test("assertCoherent: a runtime with no authored paths can't be offered to carry", () => {
  const def = baseDef();
  const issues = assertCoherent({ ...def, portability: { ...def.portability, authoredPaths: [] } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /portability\.authoredPaths is empty/);
});

test("assertCoherent: an absolute authored path only works on the machine that wrote the def", () => {
  const def = baseDef();
  const issues = assertCoherent({ ...def, portability: { ...def.portability, authoredPaths: ["/home/someone/.fixture/skills"] } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /authoredPaths entry.*is absolute/);
});

test("assertCoherent: a Windows-drive authored path is absolute too, which node:path alone doesn't say on posix", () => {
  const def = baseDef();
  const issues = assertCoherent({ ...def, portability: { ...def.portability, authoredPaths: ["C:\\Users\\someone\\.fixture"] } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /is absolute/);
});

test("assertCoherent: an authored path may not climb out of the config home", () => {
  const def = baseDef();
  const issues = assertCoherent({ ...def, portability: { ...def.portability, authoredPaths: [".fixture/../../.ssh"] } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /escapes the runtime config home/);
});

test("assertCoherent: a shared declaration with no portable keys would merge nothing", () => {
  const def = baseDef();
  const issues = assertCoherent({
    ...def,
    portability: {
      ...def.portability,
      mcp: {
        kind: "supported",
        declaration: { kind: "shared", path: ".fixture/config.toml", format: "toml", portableKeys: [] },
        loginArgs: (name) => ["mcp", "login", name],
        loginDriver: "child",
        callback: { kind: "paste-code" },
        needsAuthSignal: { kind: "in-band" },
      },
    },
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /portableKeys is empty/);
});

test("assertCoherent: the needs-auth file is a config-home path like any other", () => {
  const def = baseDef();
  const issues = assertCoherent({
    ...def,
    portability: {
      ...def.portability,
      mcp: {
        kind: "supported",
        declaration: { kind: "dedicated", path: ".fixture/mcp.json", format: "json" },
        loginArgs: (name) => ["mcp", "login", name],
        loginDriver: "pty",
        callback: { kind: "paste-code" },
        needsAuthSignal: { kind: "file", path: "/var/tmp/needs-auth.json", parse: () => [] },
      },
    },
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /needsAuthSignal\.path.*is absolute/);
});

test("assertCoherent: a fully declared MCP contract passes", () => {
  const def = baseDef();
  assert.deepEqual(
    assertCoherent({
      ...def,
      portability: {
        authoredPaths: [".fixture/skills", ".fixture/agents"],
        mcp: {
          kind: "supported",
          declaration: { kind: "shared", path: ".fixture/config.toml", format: "toml", portableKeys: ["mcp_servers"] },
          loginArgs: (name) => ["mcp", "login", name],
          loginDriver: "child",
          callback: { kind: "configurable-port", portKeyPath: (name) => ["mcp_servers", name, "oauth", "callback_port"] },
          needsAuthSignal: { kind: "file", path: ".fixture/needs-auth.json", parse: () => [] },
        },
      },
    }),
    [],
  );
});

// ---------------------------------------------------------------------
// cross-def checks — things one def can't be incoherent about alone

test("buildRegistry: two defs claiming the same id keep the first, and say so", () => {
  // `byId` is a last-wins Map, so without this the second def silently
  // becomes what every session resolving that id gets driven by.
  const first = baseDef();
  const second = { ...baseDef(), bridges: ["mcp"] as const, capabilities: { ...first.capabilities, presentChoice: "bridged" as const } };
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    const registry = buildRegistry([first, second]);
    assert.equal(registry.defs.length, 1);
    assert.equal(registry.get("fixture")?.bridges.length, 0, "the first def stays, the duplicate is dropped");
    assert.equal(logged.length, 1);
    assert.match(logged[0], /share identity\.id "fixture"/);
  } finally {
    console.error = originalError;
  }
});

test("buildRegistry: a duplicate id throws in strict mode, like any other incoherence", () => {
  assert.throws(() => buildRegistry([baseDef(), baseDef()], { strict: true }), /share identity\.id "fixture"/);
});
