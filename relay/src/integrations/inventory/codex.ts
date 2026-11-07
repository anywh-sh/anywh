// Codex's MCP inventory, in two tiers (recorded against codex-cli 0.154.0):
// `codex mcp list --json`, the declared servers, read without starting any
// of them; and the app-server's `mcpServerStatus/list`, which starts them
// and says what they serve. Plus `mcpServer/startupStatus/updated`, the
// app-server's own push as a thread's servers come up.
//
// Pure: the processes are engine.ts's and codexControl.ts's.
import type { McpLiveReport, McpServerReport } from "../../runtimes/types.js";
import type { McpAuthMode, McpServerStatus, McpTransport } from "../types.js";
import { toolsOf, urlWithoutQuery } from "./claude.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

function transportOf(raw: unknown): McpTransport | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "streamable_http") {
    const url = stringOf(raw.url);
    return url ? { type: "http", url: urlWithoutQuery(url) } : undefined;
  }
  if (raw.type !== "stdio") return undefined;
  const command = stringOf(raw.command);
  if (!command) return undefined;
  const transport: McpTransport = { type: "stdio", command };
  if (Array.isArray(raw.args)) transport.args = raw.args.filter((arg): arg is string => typeof arg === "string");
  // Names only: `env` holds values, `env_vars` names variables passed through.
  const envKeys = [
    ...(Array.isArray(raw.env_vars) ? raw.env_vars.filter((name): name is string => typeof name === "string") : []),
    ...(isRecord(raw.env) ? Object.keys(raw.env) : []),
  ];
  if (envKeys.length > 0) transport.envKeys = envKeys;
  return transport;
}

/** `auth_status` of `mcp list --json` (snake case) or `authStatus` of the
 * app-server (camel case), to how the server signs in. A static bearer
 * token is not a sign-in this relay can run. */
function authModeOf(authStatus: unknown, transport: McpTransport["type"] | undefined): McpAuthMode | undefined {
  switch (authStatus) {
    case "o_auth":
    case "oAuth":
    case "not_logged_in":
    case "notLoggedIn":
      return "oauth";
    case "bearer_token":
    case "bearerToken":
    case "unsupported":
      return "none";
    default:
      return transport === undefined ? undefined : transport === "stdio" ? "none" : "oauth";
  }
}

/** `codex mcp list --json`: `[{name, enabled, disabled_reason, transport,
 * auth_status, ...}]`. A disabled server is left out — no session loads it.
 * Without starting anything the CLI can only tell a server that has no
 * login from the rest, so everything else is `unknown` until a live read.
 * Every server is reported `user`: the list does not say where a server is
 * declared, and a project's own ones are told apart by the caller (they are
 * the ones only listed from inside that project). */
export function parseCodexMcpList(stdout: string): McpServerReport[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(Math.max(0, stdout.indexOf("["))));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const reports: McpServerReport[] = [];
  for (const server of parsed) {
    if (!isRecord(server) || typeof server.name !== "string" || server.enabled === false) continue;
    const transport = transportOf(server.transport);
    if (!transport) continue;
    const notLoggedIn = server.auth_status === "not_logged_in";
    reports.push({
      name: server.name,
      scope: "user",
      transport,
      status: notLoggedIn ? "needs_auth" : "unknown",
      authMode: authModeOf(server.auth_status, transport.type) ?? "none",
    });
  }
  return reports;
}

/** `McpServerConnectionStatus`, the live state of a server on a thread;
 * `null` without a thread, when only `authStatus` and the catalog say
 * anything. */
function liveStatusOf(server: Record<string, unknown>): McpServerStatus {
  switch (server.runtimeStatus) {
    case "connected":
      return "connected";
    case "authenticationRequired":
      return "needs_auth";
    case "failed":
    case "cancelled":
      return "failed";
    case "starting":
    case "notStarted":
      return "pending";
    default:
      break;
  }
  if (server.authStatus === "notLoggedIn") return "needs_auth";
  // Match on the fields, never on `toolsError`'s text (a long debug string).
  if (typeof server.toolsError === "string") return "failed";
  return isRecord(server.tools) ? "connected" : "unknown";
}

/** `mcpServerStatus/list`'s result, `{data: McpServerStatus[], nextCursor}`.
 * A server turned off (`runtimeStatus: "disabled"`) is left out. */
export function parseCodexMcpServerStatusList(result: unknown): { servers: McpLiveReport[]; nextCursor?: string } | undefined {
  if (!isRecord(result) || !Array.isArray(result.data)) return undefined;
  const servers: McpLiveReport[] = [];
  for (const server of result.data) {
    if (!isRecord(server) || typeof server.name !== "string" || server.runtimeStatus === "disabled") continue;
    const tools = isRecord(server.tools) ? toolsOf(Object.values(server.tools)) : undefined;
    const serverInfoName = isRecord(server.serverInfo) ? stringOf(server.serverInfo.name) : undefined;
    const authMode = authModeOf(server.authStatus, undefined);
    servers.push({
      name: server.name,
      status: liveStatusOf(server),
      ...(authMode ? { authMode } : {}),
      ...(serverInfoName ? { serverInfoName } : {}),
      // An empty catalog next to a failure is no catalog.
      ...(tools && !(tools.length === 0 && typeof server.toolsError === "string") ? { tools } : {}),
    });
  }
  const nextCursor = stringOf(result.nextCursor);
  return nextCursor ? { servers, nextCursor } : { servers };
}

/** `mcpServer/startupStatus/updated` `{threadId, name, status, error,
 * failureReason}` as a status for that server, or `undefined`. The not
 * logged in case comes as a plain `failed` whose `error` says so. */
export function parseCodexStartupStatus(params: unknown): { name: string; status: McpServerStatus } | undefined {
  if (!isRecord(params) || typeof params.name !== "string") return undefined;
  switch (params.status) {
    case "ready":
      return { name: params.name, status: "connected" };
    case "starting":
      return { name: params.name, status: "pending" };
    case "failed": {
      const auth = params.failureReason === "reauthenticationRequired" || (typeof params.error === "string" && /not logged in|auth required/i.test(params.error));
      return { name: params.name, status: auth ? "needs_auth" : "failed" };
    }
    default:
      return undefined;
  }
}
