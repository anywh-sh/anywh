// The MCP failure classifiers each def declares, against the strings the
// two CLIs were observed writing (Claude Code 2.1.303, codex-cli 0.154.0,
// a fake MCP server: 401 on the call, no login, a crash mid-call, a hang
// past the timeout, a closed port, a server's own JSON-RPC error).
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeRuntimeDef } from "./defs/claude/index.js";
import { codexRuntimeDef } from "./defs/codex.js";
import { classifyMcpFailure } from "./mcpFailure.js";
import type { AgentRuntimeDef, McpFailureClassifier } from "./types.js";

function classifierOf(def: AgentRuntimeDef): McpFailureClassifier {
  const mcp = def.portability.mcp;
  assert.ok(mcp.kind === "supported" && mcp.failureClassifier, `${def.identity.id} declares a classifier`);
  return mcp.failureClassifier;
}

test("Claude: an expired session is a sign-in, the rest by what happened, and anything else offers nothing", () => {
  const classifier = classifierOf(claudeRuntimeDef);
  const cases: [string, string][] = [
    ['MCP server "expiring" session expired', "auth"],
    ['MCP server "fake" tool "hang" timed out after 15s', "timeout"],
    ["Connection closed", "crashed"],
    ["ECONNREFUSED: Unable to connect to http://127.0.0.1:9/mcp", "unreachable"],
    ["upstream exploded", "server_error"],
    // A tool's own error is no reason to sign in again.
    ["Issue does not exist or you do not have permission to see it.", "server_error"],
  ];
  for (const [text, reason] of cases) assert.equal(classifyMcpFailure(classifier, { text }), reason, text);
});

test("Codex: the WWW-Authenticate of the server's result is a sign-in whatever its text", () => {
  const classifier = classifierOf(codexRuntimeDef);
  assert.equal(classifyMcpFailure(classifier, { text: "Authentication required", meta: { "mcp/www_authenticate": ['Bearer error="invalid_token"'] } }), "auth");
  assert.equal(classifyMcpFailure(classifier, { text: "something else entirely", meta: { "mcp/www_authenticate": [] } }), "auth");
  assert.equal(classifyMcpFailure(classifier, { text: "something else entirely", meta: { other: true } }), "server_error");
});

test("Codex: errors of the app-server by what happened", () => {
  const classifier = classifierOf(codexRuntimeDef);
  const cases: [string, string][] = [
    ["failed to get client: MCP startup failed: handshaking with MCP server failed: Auth required, when send initialize request", "auth"],
    ["The atl MCP server is not logged in. Run `codex mcp login atl`.", "auth"],
    ["failed to refresh OAuth tokens", "auth"],
    ["tool call failed for `fake/crash`: Transport closed", "crashed"],
    ["tool call failed for `fake/hang`: timed out awaiting tools/call after 10s", "timeout"],
    ["failed to get client: MCP startup failed: MCP client for `bootcrash` failed to start: connection closed", "unreachable"],
    ["failed to get client: MCP startup failed: Send message error Transport [rmcp::transport::worker::WorkerTransport] error", "unreachable"],
    ["upstream exploded", "server_error"],
  ];
  for (const [text, reason] of cases) assert.equal(classifyMcpFailure(classifier, { text }), reason, text);
});
