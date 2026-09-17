import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCoherent } from "../../registry.js";
import { claudeRuntimeDef } from "./def.js";
import type { TurnContext } from "../../types.js";

function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return { cwd: "/tmp/project", prompt: "hi", permissionModeId: "default", ...overrides };
}

test("claudeRuntimeDef is coherent", () => {
  assert.deepEqual(assertCoherent(claudeRuntimeDef), []);
});

test("exec.buildArgs: builds the base argv for a turn, without MCP flags", () => {
  const args = claudeRuntimeDef.exec.kind === "spawnPerTurn" ? claudeRuntimeDef.exec.buildArgs(turnContext()) : [];
  assert.deepEqual(args.slice(0, 2), ["-p", "hi"]);
  assert.ok(!args.includes("--mcp-config"));
});

test("exec.buildArgs: resumeSessionId appends --resume at the end", () => {
  if (claudeRuntimeDef.exec.kind !== "spawnPerTurn") throw new Error("expected spawnPerTurn");
  const args = claudeRuntimeDef.exec.buildArgs(turnContext({ resumeSessionId: "sess-123" }));
  assert.deepEqual(args.slice(-2), ["--resume", "sess-123"]);
});

test("exec.mapStdoutLine: maps a real stream-json line via mapClaudeEvent", () => {
  if (claudeRuntimeDef.exec.kind !== "spawnPerTurn") throw new Error("expected spawnPerTurn");
  const line = JSON.stringify({
    type: "user_prompt",
    message: { content: [{ type: "text", text: "hello" }] },
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  const events = claudeRuntimeDef.exec.mapStdoutLine(line, { turnId: "t1" });
  assert.ok(events.length > 0);
});

test("exec.mapStdoutLine: invalid JSON degrades to no events instead of throwing", () => {
  if (claudeRuntimeDef.exec.kind !== "spawnPerTurn") throw new Error("expected spawnPerTurn");
  assert.deepEqual(claudeRuntimeDef.exec.mapStdoutLine("not json", { turnId: "t1" }), []);
});

test("auth.parse: maps ClaudeAuthStatus onto AuthStatus, dropping subscriptionType", () => {
  if (claudeRuntimeDef.auth.kind !== "cli-probe") throw new Error("expected cli-probe");
  const status = claudeRuntimeDef.auth.parse(JSON.stringify({ loggedIn: true, email: "user@example.com", subscriptionType: "max" }));
  assert.deepEqual(status, { loggedIn: true, account: "user@example.com" });
});

test("permissions.modesFor: same four modes on every platform, default survives", () => {
  const modes = claudeRuntimeDef.permissions.modesFor("linux").map((mode) => mode.id);
  assert.deepEqual(modes, ["default", "acceptEdits", "plan", "bypassPermissions"]);
  assert.deepEqual(claudeRuntimeDef.permissions.modesFor("win32").map((mode) => mode.id), modes);
});

test("classifyFailure: session-invalid, usage-limit, not-installed, and a transient fallback", () => {
  assert.equal(claudeRuntimeDef.classifyFailure?.({ text: "No conversation found to continue" }), "session-invalid");
  assert.equal(claudeRuntimeDef.classifyFailure?.({ text: "Claude AI usage limit reached|1735689600" }), "usage-limit");
  assert.equal(claudeRuntimeDef.classifyFailure?.({ text: "spawn claude ENOENT" }), "not-installed");
  assert.equal(claudeRuntimeDef.classifyFailure?.({ text: "Overloaded" }), "transient");
});
