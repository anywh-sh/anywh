import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPersistentArgs, encodeInterrupt, encodeUserMessage, persistentEnvOverrides } from "./persistent.js";
import { CLAUDE_AGENT_ENV_OVERRIDES, CLAUDE_AGENT_WORKER_ENV } from "./session.js";

test("a persistent agent reads stream-json turns from stdin and resumes by session id", () => {
  const args = buildPersistentArgs(
    { agentWorker: true, model: "haiku", effort: "low", permissionMode: "acceptEdits", appendSystemPrompt: "be brief", allowedTools: "Read", disallowedTools: "Agent", permissionPromptTool: "mcp__p__ask" },
    { mcpConfigPath: "/tmp/x/mcp.json", resumeSessionId: "s-1" },
  );
  assert.deepEqual(args, [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--append-system-prompt", "be brief", "--model", "haiku", "--effort", "low", "--permission-mode", "acceptEdits",
    "--setting-sources", "project,local", "--mcp-config", "/tmp/x/mcp.json", "--allowedTools", "Read",
    "--permission-prompt-tool", "mcp__p__ask", "--disallowedTools", "Agent", "--resume", "s-1",
  ]);
});

test("bypass mode uses the dedicated flag; a non-worker keeps the user's settings; partial messages can be turned off", () => {
  const args = buildPersistentArgs({ agentWorker: false, permissionMode: "bypassPermissions", partialMessages: false }, {});
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--permission-mode"));
  assert.ok(!args.includes("--setting-sources"));
  assert.ok(!args.includes("--include-partial-messages"));
  assert.ok(!args.includes("--resume"));
  // An unknown mode id never reaches the CLI as-is.
  const fallback = buildPersistentArgs({ agentWorker: false, permissionMode: "nonsense" }, {});
  assert.equal(fallback[fallback.indexOf("--permission-mode") + 1], "default");
});

test("stdin lines: a user message and an interrupt control request", () => {
  assert.deepEqual(JSON.parse(encodeUserMessage("hi")), { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
  assert.deepEqual(JSON.parse(encodeInterrupt("r1")), { type: "control_request", request_id: "r1", request: { subtype: "interrupt" } });
  assert.ok(encodeUserMessage("a\nb").endsWith("}\n"));
});

test("worker env opt-outs only for an agent worker", () => {
  assert.deepEqual(persistentEnvOverrides(false), CLAUDE_AGENT_ENV_OVERRIDES);
  assert.deepEqual(persistentEnvOverrides(true), { ...CLAUDE_AGENT_ENV_OVERRIDES, ...CLAUDE_AGENT_WORKER_ENV });
});
