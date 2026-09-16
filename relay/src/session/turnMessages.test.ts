import { test } from "node:test";
import assert from "node:assert/strict";
import type { FinishedBackgroundJob } from "../host/backgroundJobs.js";
import { APPROVE_OPTION_ID, DENY_OPTION_ID, buildApprovalQuestion, buildBackgroundJobFollowupPrompt, buildMcpSpawnConfig, describeToolCall, isApproved } from "./turnMessages.js";

// Merged into this file from the standalone approvalPrompt.test.ts — it was
// the one test file whose name didn't match the module it tested; that
// anomaly went away with the module itself moving here.

/**
 * The permission prompt, which no integration test can reach: the real path
 * needs a `claude` child speaking MCP's Streamable HTTP transport mid-turn,
 * and the fake claude fixture doesn't implement it. What it guards is worth
 * the extra seam — `isApproved` is the single comparison standing between a
 * user saying no and a command running on their machine.
 */
test("carries the parts the client needs to ask in its own language", () => {
  const question = buildApprovalQuestion("Bash", { command: "rm -rf build" });
  assert.deepEqual(question.approval, { tool: "Bash", detail: "rm -rf build" });
  // The English sentence stays filled in for a client too old to read
  // `approval` — it is a fallback, not the only copy.
  assert.match(question.question, /Bash/);
  assert.match(question.question, /rm -rf build/);
});

test("gives the plan-mode transition no detail to print", () => {
  const question = buildApprovalQuestion("ExitPlanMode", {});
  assert.deepEqual(question.approval, { tool: "ExitPlanMode", detail: "" });
});

test("offers exactly the two ids the verdict is read from", () => {
  const question = buildApprovalQuestion("Write", { file_path: "/tmp/x" });
  assert.deepEqual(
    question.options.map((option) => option.id),
    [APPROVE_OPTION_ID, DENY_OPTION_ID],
  );
});

test("reads the verdict from the id, not from the label", () => {
  // The whole point of the change: a client that translates its buttons must
  // not be able to change what the relay decides.
  assert.equal(isApproved([{ question: "q", selected: [APPROVE_OPTION_ID] }]), true);
  assert.equal(isApproved([{ question: "q", selected: ["Aprovar"] }]), false);
  assert.equal(isApproved([{ question: "q", selected: ["Approve"] }]), false);
});

test("treats anything that is not an explicit approval as a refusal", () => {
  assert.equal(isApproved([{ question: "q", selected: [DENY_OPTION_ID] }]), false);
  assert.equal(isApproved([{ question: "q", selected: [] }]), false);
  assert.equal(isApproved([]), false);
  assert.equal(isApproved([{ question: "q", selected: ["something the user typed"] }]), false);
});

test("describeToolCall: Bash picks the command field", () => {
  assert.equal(describeToolCall("Bash", { command: "ls -la" }), "ls -la");
});

test("describeToolCall: Bash falls back to a JSON dump when command is missing", () => {
  assert.equal(describeToolCall("Bash", { cwd: "/tmp" }), JSON.stringify({ cwd: "/tmp" }));
});

test("describeToolCall: Write/Edit/NotebookEdit pick file_path, then notebook_path", () => {
  assert.equal(describeToolCall("Write", { file_path: "/a.txt" }), "/a.txt");
  assert.equal(describeToolCall("Edit", { file_path: "/b.txt" }), "/b.txt");
  assert.equal(describeToolCall("NotebookEdit", { notebook_path: "/c.ipynb" }), "/c.ipynb");
  assert.equal(describeToolCall("Edit", {}), "{}", "falls back to a JSON dump when neither field is present");
});

test("describeToolCall: an unrecognized tool falls back to a JSON dump, truncated past 200 chars", () => {
  assert.equal(describeToolCall("SomeOtherTool", { a: 1 }), JSON.stringify({ a: 1 }));
  const longInput = { text: "x".repeat(300) };
  const described = describeToolCall("SomeOtherTool", longInput);
  assert.equal(described.length, 201, "200 chars of JSON plus the ellipsis character");
  assert.ok(described.endsWith("…"));
});

function job(overrides: Partial<FinishedBackgroundJob> = {}): FinishedBackgroundJob {
  return {
    sessionId: "s1",
    id: "job-1",
    label: "npm run build",
    logPath: "/tmp/job-1.log",
    exitPath: "/tmp/job-1.exit",
    startedAt: Date.now(),
    pid: 12345,
    exitCode: 0,
    logTail: "build output",
    ...overrides,
  };
}

test("buildBackgroundJobFollowupPrompt: terminated externally reports no exit code", () => {
  const prompt = buildBackgroundJobFollowupPrompt(job({ terminated: true, exitCode: -1 }));
  assert.match(prompt, /encerrado de fora, sem exit code/);
  assert.doesNotMatch(prompt, /exit -1/);
});

test("buildBackgroundJobFollowupPrompt: exit 0 reports success", () => {
  const prompt = buildBackgroundJobFollowupPrompt(job({ exitCode: 0 }));
  assert.match(prompt, /concluiu com sucesso \(exit 0\)/);
});

test("buildBackgroundJobFollowupPrompt: a nonzero exit reports the code", () => {
  const prompt = buildBackgroundJobFollowupPrompt(job({ exitCode: 2 }));
  assert.match(prompt, /terminou com erro \(exit 2\)/);
});

test("buildBackgroundJobFollowupPrompt: always names the job and includes the log tail", () => {
  const prompt = buildBackgroundJobFollowupPrompt(job({ label: "npm run build", logTail: "compiled ok" }));
  assert.match(prompt, /"npm run build"/);
  assert.match(prompt, /compiled ok/);
});

test("buildBackgroundJobFollowupPrompt: an empty log tail (only whitespace) falls back to a placeholder", () => {
  const prompt = buildBackgroundJobFollowupPrompt(job({ logTail: "   \n  " }));
  assert.match(prompt, /\(sem saída\)/);
});

interface ParsedMcpServer {
  url: string;
  alwaysLoad: boolean;
  timeout?: number;
}

function parseMcpServers(configJson: string): Record<string, ParsedMcpServer> {
  return (JSON.parse(configJson) as { mcpServers: Record<string, ParsedMcpServer> }).mcpServers;
}

test("buildMcpSpawnConfig: neither token registered means no --mcp-config at all", () => {
  const mcp = buildMcpSpawnConfig({ choiceToken: undefined, permissionToken: undefined, mcpBridgeBaseUrl: "http://127.0.0.1:1/choice", mcpPermissionBridgeBaseUrl: "http://127.0.0.1:1/perm" });
  assert.equal(mcp, undefined);
});

test("buildMcpSpawnConfig: only the choice bridge registered gets its server, allowedTools, disallowedTools and the system-prompt hint — no permissionPromptTool", () => {
  const mcp = buildMcpSpawnConfig({ choiceToken: "tok-choice", permissionToken: undefined, mcpBridgeBaseUrl: "http://127.0.0.1:1/choice", mcpPermissionBridgeBaseUrl: "http://127.0.0.1:1/perm" });
  assert.ok(mcp);
  const servers = parseMcpServers(mcp.configJson);
  assert.deepEqual(Object.keys(servers), ["anywh-choice"]);
  assert.equal(servers["anywh-choice"].url, "http://127.0.0.1:1/choice/tok-choice");
  assert.equal(servers["anywh-choice"].alwaysLoad, true);
  assert.equal(servers["anywh-choice"].timeout, undefined);
  assert.equal(mcp.allowedTools, "mcp__anywh-choice__present_choice");
  assert.equal(mcp.disallowedTools, "AskUserQuestion");
  assert.ok(mcp.extraSystemPrompt);
  assert.equal(mcp.permissionPromptTool, undefined);
});

test("buildMcpSpawnConfig: only the permission bridge registered gets its server with the 24h timeout override, and permissionPromptTool — no choice-only fields", () => {
  const mcp = buildMcpSpawnConfig({ choiceToken: undefined, permissionToken: "tok-perm", mcpBridgeBaseUrl: "http://127.0.0.1:1/choice", mcpPermissionBridgeBaseUrl: "http://127.0.0.1:1/perm" });
  assert.ok(mcp);
  const servers = parseMcpServers(mcp.configJson);
  assert.deepEqual(Object.keys(servers), ["anywh-permission"]);
  assert.equal(servers["anywh-permission"].url, "http://127.0.0.1:1/perm/tok-perm");
  assert.equal(servers["anywh-permission"].timeout, 24 * 60 * 60 * 1000);
  assert.equal(mcp.permissionPromptTool, "mcp__anywh-permission__approve");
  assert.equal(mcp.allowedTools, undefined);
  assert.equal(mcp.disallowedTools, undefined);
  assert.equal(mcp.extraSystemPrompt, undefined);
});

test("buildMcpSpawnConfig: both bridges registered at once (default/acceptEdits) get both servers and all five fields together", () => {
  const mcp = buildMcpSpawnConfig({ choiceToken: "tok-choice", permissionToken: "tok-perm", mcpBridgeBaseUrl: "http://127.0.0.1:1/choice", mcpPermissionBridgeBaseUrl: "http://127.0.0.1:1/perm" });
  assert.ok(mcp);
  const servers = parseMcpServers(mcp.configJson);
  assert.deepEqual(new Set(Object.keys(servers)), new Set(["anywh-choice", "anywh-permission"]));
  assert.ok(mcp.allowedTools);
  assert.ok(mcp.permissionPromptTool);
  assert.ok(mcp.disallowedTools);
  assert.ok(mcp.extraSystemPrompt);
});
