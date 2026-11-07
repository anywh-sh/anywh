// Claude Code's MCP inventory, as its own control protocol reports it: the
// reply to the `mcp_status` control request on a `claude -p --input-format
// stream-json` process (recorded against Claude Code 2.1.303), and the
// `mcp_servers` a turn's `system`/`init` event carries.
//
// Pure: the process is claudeControl.ts's, the scheduling engine.ts's.
import type { McpServerReport } from "../../runtimes/types.js";
import type { McpAuthMode, McpScope, McpServerStatus, McpToolInfo, McpTransport } from "../types.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** `status` as the CLI spells it. `disabled` is a server the person turned
 * off: not something a session loads, so it is left out (`null`). */
function statusOf(raw: unknown): McpServerStatus | null {
  switch (raw) {
    case "connected":
      return "connected";
    case "needs-auth":
      return "needs_auth";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    case "disabled":
      return null;
    default:
      return "unknown";
  }
}

/** `source` first: it tells a plugin's server (`scope: "dynamic"`) from one
 * handed over with `--mcp-config` (also `dynamic`, `source: "dynamic"`). */
function scopeOf(source: unknown, scope: unknown): McpScope {
  const value = stringOf(source) ?? stringOf(scope) ?? "";
  switch (value) {
    case "user":
    case "local":
    case "project":
    case "plugin":
    case "claudeai":
    case "managed":
      return value;
    case "enterprise":
      return "managed";
    default:
      return "override";
  }
}

/** A URL without its query or fragment: some servers take a key there, and
 * nothing that reads the inventory needs it. */
export function urlWithoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Flags whose value is a credential (`--header "Authorization: Bearer …"`,
 * `--api-key …`). */
const SECRET_FLAG = /^--?(h|headers?|api[-_]?key|(access[-_]?)?token|auth(orization)?|bearer|password|secret|client[-_]?secret)$/i;
const SECRET_VALUE = /\b(bearer|basic)\s+\S|authorization\s*:/i;
export const REDACTED_ARG = "<redacted>";

/** A server's arguments with every credential in them replaced by
 * `REDACTED_ARG` and every URL without its query; `redacted` says whether
 * there was one. What is left still tells what the server runs. */
export function argsWithoutSecrets(args: readonly string[]): { args: string[]; redacted: boolean } {
  let redacted = false;
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const flag = /^(-[^=]+)=/.exec(arg)?.[1];
    if (flag !== undefined && SECRET_FLAG.test(flag)) {
      out.push(`${flag}=${REDACTED_ARG}`);
      redacted = true;
    } else if (SECRET_FLAG.test(arg) && index + 1 < args.length) {
      out.push(arg, REDACTED_ARG);
      index += 1;
      redacted = true;
    } else if (SECRET_VALUE.test(arg)) {
      out.push(REDACTED_ARG);
      redacted = true;
    } else if (/^https?:\/\//i.test(arg) && urlWithoutQuery(arg) !== arg) {
      out.push(urlWithoutQuery(arg));
      redacted = true;
    } else {
      out.push(arg);
    }
  }
  return { args: out, redacted };
}

const stringArgs = (raw: unknown[]): string[] => raw.filter((arg): arg is string => typeof arg === "string");

function transportOf(config: Record<string, unknown>): McpTransport | undefined {
  const type = config.type ?? (typeof config.command === "string" ? "stdio" : undefined);
  if (type !== "stdio" && type !== "http" && type !== "sse" && type !== "claudeai-proxy") return undefined;
  const transport: McpTransport = { type };
  const url = stringOf(config.url);
  if (url) transport.url = urlWithoutQuery(url);
  const command = stringOf(config.command);
  if (command) transport.command = command;
  if (Array.isArray(config.args)) transport.args = argsWithoutSecrets(stringArgs(config.args)).args;
  if (isRecord(config.env)) transport.envKeys = Object.keys(config.env);
  return transport;
}

function authModeOf(type: McpTransport["type"]): McpAuthMode {
  if (type === "claudeai-proxy") return "claudeai";
  // A remote server signs in through the CLI's own OAuth when it asks to; a
  // stdio one is handed its credentials in its environment.
  return type === "stdio" ? "none" : "oauth";
}

/** The config to hand back to the CLI (`--mcp-config`) to start a process
 * with only this server: the keys that name the server, never its
 * environment, headers or URL query (where credentials live). A server
 * whose arguments carry one gets none: it would not start without it, and
 * its calls go through the profile's own process instead. */
function claudeConfigOf(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const kept: Record<string, unknown> = {};
  for (const key of ["type", "id", "command"]) {
    if (config[key] !== undefined) kept[key] = config[key];
  }
  if (typeof config.url === "string") kept.url = urlWithoutQuery(config.url);
  if (Array.isArray(config.args)) {
    const args = argsWithoutSecrets(stringArgs(config.args));
    if (args.redacted) return undefined;
    kept.args = args.args;
  }
  return kept;
}

export function toolsOf(raw: unknown): McpToolInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tools: McpToolInfo[] = [];
  for (const tool of raw) {
    if (!isRecord(tool) || typeof tool.name !== "string") continue;
    const info: McpToolInfo = { name: tool.name };
    // Claude reports the MCP `readOnlyHint` as `readOnly`; both are read.
    const annotations = isRecord(tool.annotations) ? tool.annotations : {};
    const readOnly = annotations.readOnly ?? annotations.readOnlyHint;
    if (typeof readOnly === "boolean") info.readOnly = readOnly;
    tools.push(info);
  }
  return tools;
}

/** The `response` of a successful `mcp_status` control response —
 * `{mcpServers: [{name, status, config, scope, source, serverInfo?, tools?,
 * error?}]}` — or `undefined` for anything else. A server with a transport
 * this relay has no name for (an IDE bridge) is left out. */
export function parseClaudeMcpStatus(response: unknown): McpServerReport[] | undefined {
  if (!isRecord(response) || !Array.isArray(response.mcpServers)) return undefined;
  const reports: McpServerReport[] = [];
  for (const server of response.mcpServers) {
    if (!isRecord(server) || typeof server.name !== "string" || !isRecord(server.config)) continue;
    const status = statusOf(server.status);
    if (status === null) continue;
    const transport = transportOf(server.config);
    if (!transport) continue;
    const report: McpServerReport = {
      name: server.name,
      scope: scopeOf(server.source, server.scope),
      transport,
      status,
      authMode: authModeOf(transport.type),
    };
    const claudeConfig = claudeConfigOf(server.config);
    if (claudeConfig) report.claudeConfig = claudeConfig;
    const serverInfoName = isRecord(server.serverInfo) ? stringOf(server.serverInfo.name) : undefined;
    if (serverInfoName) report.serverInfoName = serverInfoName;
    const tools = toolsOf(server.tools);
    if (tools) report.tools = tools;
    reports.push(report);
  }
  return reports;
}

/** A server's name as the CLI spells it inside a tool's full name
 * (`mcp__<server>__<tool>`): anything but a letter, a digit, `_` or `-`
 * becomes `_` — `claude.ai Atlassian` is `claude_ai_Atlassian`. */
export function normalizeMcpServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The servers a turn's `system`/`init` event lists, `[{name, status}]`.
 * Only `needs-auth` is worth anything there: everything else is reported
 * `pending`, because the event is written before the servers finish
 * starting. */
export function parseClaudeInitMcpServers(event: unknown): { name: string; status: McpServerStatus }[] {
  if (!isRecord(event) || event.type !== "system" || event.subtype !== "init" || !Array.isArray(event.mcp_servers)) return [];
  const servers: { name: string; status: McpServerStatus }[] = [];
  for (const server of event.mcp_servers) {
    if (!isRecord(server) || typeof server.name !== "string") continue;
    const status = statusOf(server.status);
    if (status === "needs_auth") servers.push({ name: server.name, status });
  }
  return servers;
}

/** The part of `~/.claude.json` that decides which servers load: the user's
 * servers and, per project, its own servers and `.mcp.json` approvals. The
 * file also holds caches and counters rewritten all the time; a change
 * outside this slice is no reason to rescan. */
export function claudeJsonMcpSlice(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Caught mid-write: the next event carries the finished file.
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const projects: Record<string, unknown> = {};
  if (isRecord(parsed.projects)) {
    for (const [path, project] of Object.entries(parsed.projects)) {
      if (!isRecord(project)) continue;
      projects[path] = [project.mcpServers, project.disabledMcpServers, project.enabledMcpjsonServers, project.disabledMcpjsonServers, project.enableAllProjectMcpServers];
    }
  }
  return { servers: parsed.mcpServers, projects };
}
