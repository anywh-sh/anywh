import { test } from "node:test";
import assert from "node:assert/strict";
import type { RoomAgentSetup } from "../../types.js";
import { buildPersistentArgs } from "./persistent.js";
import { buildClaudeHostSpec } from "./roomSpec.js";

const setup = (role: "principal" | "worker"): RoomAgentSetup => ({
  role,
  instructions: `you are the ${role}`,
  tools: role === "principal" ? [{ name: "delegate", description: "", inputSchema: {} }, { name: "room_status", description: "", inputSchema: {} }] : [{ name: "report", description: "", inputSchema: {} }],
  bridgeServerName: "anywh-room",
  bridgeUrl: "http://127.0.0.1:1/room/x/tok",
});

const ctx = { cwd: "/w", prompt: "", permissionModeId: "bypassPermissions", modelId: "haiku" };

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

test("the principal is read-only for real: only Read/Grep/Glob exist, writing and native subagents are denied, only the room's MCP server is loaded", () => {
  const spec = buildClaudeHostSpec(ctx, setup("principal"));
  const args = buildPersistentArgs(spec, { mcpConfigPath: "/tmp/x.json" });
  assert.equal(flag(args, "--tools"), "Read,Grep,Glob");
  const denied = flag(args, "--disallowedTools")!.split(",");
  for (const tool of ["Agent", "Task", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "EnterWorktree", "CronCreate", "RemoteTrigger", "Skill", "SlashCommand", "KillShell", "Monitor", "ScheduleWakeup"]) assert.ok(denied.includes(tool), `${tool} denied`);
  assert.deepEqual(flag(args, "--allowedTools")!.split(","), ["Read", "Grep", "Glob", "mcp__anywh-room__delegate", "mcp__anywh-room__room_status"]);
  assert.ok(args.includes("--strict-mcp-config"), "the user's MCP servers are not loaded into the principal");
  assert.equal(spec.strictMcp, true);
  assert.equal(spec.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, undefined);
  assert.equal(flag(args, "--append-system-prompt"), "you are the principal");
  assert.deepEqual(JSON.parse(spec.mcpConfigJson!), { mcpServers: { "anywh-room": { type: "http", url: "http://127.0.0.1:1/room/x/tok", alwaysLoad: true } } });
});

test("a worker keeps every tool and the user's MCP servers, with native subagents capped at 5 concurrent and depth 1", () => {
  const spec = buildClaudeHostSpec(ctx, setup("worker"));
  const args = buildPersistentArgs(spec, { mcpConfigPath: "/tmp/x.json" });
  assert.equal(flag(args, "--tools"), undefined);
  assert.equal(flag(args, "--disallowedTools"), undefined);
  assert.ok(!args.includes("--strict-mcp-config"));
  assert.equal(flag(args, "--allowedTools"), "mcp__anywh-room__report");
  assert.deepEqual(spec.env, { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "5", CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" });
  assert.equal(spec.agentWorker, true);
  assert.equal(flag(args, "--setting-sources"), "project,local");
});

test("without a room the spec is just the turn's own choices", () => {
  const spec = buildClaudeHostSpec({ ...ctx, effortId: "high", permissionModeId: "acceptEdits" }, undefined);
  assert.deepEqual(spec, { cwd: "/w", model: "haiku", effort: "high", permissionMode: "acceptEdits", agentWorker: true });
});

test("a room's context folder is granted to the agent with --add-dir, principal and worker alike", () => {
  for (const role of ["principal", "worker"] as const) {
    const spec = buildClaudeHostSpec(ctx, { ...setup(role), addDirs: ["/home/u/.anywh/rooms/r1"] });
    const args = buildPersistentArgs(spec, {});
    assert.equal(flag(args, "--add-dir"), "/home/u/.anywh/rooms/r1");
  }
  assert.equal(buildPersistentArgs(buildClaudeHostSpec(ctx, setup("worker")), {}).includes("--add-dir"), false);
});
