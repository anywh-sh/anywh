// How Claude Code words a failed MCP tool call, as the `tool_result` text
// the turn carries (`is_error: true`). Observed on 2.1.303 against a fake
// server: a 401 on `tools/call` (the token expired during the session —
// the server stays `connected`), a server that died mid-call (it
// reconnects by itself), a call past `MCP_TOOL_TIMEOUT`, a refused
// connection. A server's own JSON-RPC error comes through as its raw
// message: `server_error`.
import type { McpFailureClassifier } from "../../types.js";

export const CLAUDE_MCP_FAILURE_CLASSIFIER: McpFailureClassifier = {
  recordedWith: "2.1.303",
  rules: [
    // `MCP server "expiring" session expired`
    { reason: "auth", pattern: /\bsession expired\b/i },
    // `MCP server "fake" tool "hang" timed out after 15s`
    { reason: "timeout", pattern: /\btimed out\b/i },
    // `ECONNREFUSED: Unable to connect…`
    { reason: "unreachable", pattern: /ECONNREFUSED|failed to start/i },
    // `Connection closed`
    { reason: "crashed", pattern: /\bconnection closed\b|\btransport closed\b/i },
  ],
};
