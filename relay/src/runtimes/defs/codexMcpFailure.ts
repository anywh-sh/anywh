// How codex-cli words a failed MCP tool call: the `mcpToolCall` item's
// `error.message` (a JSON-RPC error of the app-server), or the server's
// own `CallToolResult` with `isError`. Observed on 0.154.0 through
// `mcpServer/tool/call` against a fake server: a 401 on the call comes back
// as a result whose `_meta` carries `mcp/www_authenticate` (the one
// structured auth signal of either CLI); a server with no login fails with
// "Auth required"; a server that died mid-call stays dead ("Transport
// closed"); a call past `tool_timeout_sec` "timed out awaiting tools/call";
// a server that never started "failed to get client: MCP startup failed".
import type { McpFailureClassifier } from "../types.js";

export const CODEX_MCP_FAILURE_CLASSIFIER: McpFailureClassifier = {
  recordedWith: "0.154.0",
  authMetaKeys: ["mcp/www_authenticate"],
  rules: [
    // `The atl MCP server is not logged in. Run \`codex mcp login atl\`.`,
    // `… MCP startup failed: … Auth required`, `Authentication required`,
    // and a refresh that failed.
    { reason: "auth", pattern: /not logged in|auth(entication)? required|failed to refresh OAuth tokens/i },
    // `-32603 … timed out awaiting tools/call after 10s`
    { reason: "timeout", pattern: /\btimed out\b/i },
    // `failed to get client: MCP startup failed: …`, `… failed to start: …`
    { reason: "unreachable", pattern: /ECONNREFUSED|failed to start|startup failed|failed to get client/i },
    // `tool call failed for \`fake/crash\`: Transport closed`
    { reason: "crashed", pattern: /\btransport closed\b|\bconnection closed\b/i },
  ],
};
