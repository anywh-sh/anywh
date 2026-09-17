import { test } from "node:test";
import assert from "node:assert/strict";
import { availableModes, isOfferedMode, resolveInitialMode } from "./permissionModes.js";
import type { AgentRuntimeDef, HostPlatform } from "../runtimes/types.js";

// `availableModes`/`isOfferedMode`/`resolveInitialMode` only ever touch
// `def.permissions` — everything else `AgentRuntimeDef` requires (identity,
// capabilities, exec, ...) is irrelevant here, so these fixtures only
// declare `permissions` and cast the rest away rather than hand-filling
// fields this file has no business constructing (and, for `exec.kind`,
// isn't even allowed to reference outside `runtimes/` — see
// architecture.test.ts).
function fakeDef(permissions: AgentRuntimeDef["permissions"]): AgentRuntimeDef {
  return { permissions } as unknown as AgentRuntimeDef;
}

// A Claude-shaped fixture: same four modes on every platform, nothing win32-specific.
function claudeLikeDef(): AgentRuntimeDef {
  return fakeDef({
    defaultModeId: "bypassPermissions",
    modesFor: () => [
      { id: "default", labelKey: "mode.default", settings: undefined, pausesForApproval: true },
      { id: "acceptEdits", labelKey: "mode.acceptEdits", settings: undefined, pausesForApproval: true },
      { id: "plan", labelKey: "mode.plan", settings: undefined, pausesForApproval: true },
      { id: "bypassPermissions", labelKey: "mode.bypassPermissions", settings: undefined, pausesForApproval: false },
    ],
  });
}

// A Codex-shaped fixture: three modes, but the "workspace-write" one doesn't exist on win32.
function codexLikeDef(): AgentRuntimeDef {
  return fakeDef({
    defaultModeId: "workspace-write",
    modesFor: (platform: HostPlatform) => {
      const modes = [
        { id: "read-only", labelKey: "mode.readOnly", settings: undefined, pausesForApproval: true },
        { id: "workspace-write", labelKey: "mode.workspaceWrite", settings: undefined, pausesForApproval: true },
        { id: "full-access", labelKey: "mode.fullAccess", settings: undefined, pausesForApproval: false },
      ];
      return platform === "win32" ? modes.filter((m) => m.id !== "workspace-write") : modes;
    },
  });
}

test("availableModes maps a def's modesFor to id + pausesForApproval, dropping labelKey/settings", () => {
  const modes = availableModes(claudeLikeDef(), "linux");
  assert.deepEqual(modes, [
    { id: "default", pausesForApproval: true },
    { id: "acceptEdits", pausesForApproval: true },
    { id: "plan", pausesForApproval: true },
    { id: "bypassPermissions", pausesForApproval: false },
  ]);
});

test("availableModes reflects a platform-specific gap (Codex's workspace-write, absent on win32)", () => {
  assert.equal(availableModes(codexLikeDef(), "linux").length, 3);
  const win32Modes = availableModes(codexLikeDef(), "win32");
  assert.equal(win32Modes.length, 2);
  assert.ok(!isOfferedMode(win32Modes, "workspace-write"));
});

test("isOfferedMode", () => {
  const modes = availableModes(claudeLikeDef(), "linux");
  assert.equal(isOfferedMode(modes, "plan"), true);
  assert.equal(isOfferedMode(modes, "not_a_mode"), false);
});

test("resolveInitialMode: a persisted mode this platform offers wins, even if it isn't the default", () => {
  const modes = availableModes(claudeLikeDef(), "linux");
  assert.equal(resolveInitialMode(modes, "plan", "bypassPermissions"), "plan");
});

test("resolveInitialMode: a persisted mode this platform doesn't offer falls back to the def's default", () => {
  const win32Modes = availableModes(codexLikeDef(), "win32");
  // Persisted on Linux, read on win32 — workspace-write no longer exists there.
  assert.equal(resolveInitialMode(win32Modes, "workspace-write", "read-only"), "read-only");
});

test("resolveInitialMode: a default this platform also doesn't offer falls back to the first mode offered", () => {
  const win32Modes = availableModes(codexLikeDef(), "win32");
  // Neither the persisted value nor the (Codex-real) default survive on win32.
  assert.equal(resolveInitialMode(win32Modes, "workspace-write", "workspace-write"), win32Modes[0].id);
});
