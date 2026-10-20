// Spawn shape for a Claude "agent worker" (a session driven by the relay on
// behalf of another agent, not typed into by a person): it inherits the MCP
// servers the user already configured, but none of their personal plugins,
// skills or hooks. Ordinary sessions do not use any of this.
//
// Measured against Claude Code 2.1.303 (`system`/`init` event as evidence):
//   - `--setting-sources project,local` drops everything that comes from the
//     user scope: plugins (and the MCP servers plugins bring), user skills,
//     user hooks, user CLAUDE.md, and the user-scope `mcpServers` of
//     ~/.claude.json. It keeps the project's `.mcp.json`, project skills and
//     hooks, and the local-scope servers of ~/.claude.json `projects[cwd]`.
//   - So the user-scope servers are read here and handed over through
//     `--mcp-config`. `--strict-mcp-config` is deliberately NOT added: it
//     would also drop the account connectors (claude.ai) the user has.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_WORKER_SETTING_SOURCES = "project,local";

type McpServerEntries = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The user-scope `mcpServers` map out of the text of ~/.claude.json. Entries
 * that are not objects are dropped; anything unparsable yields no servers. */
export function parseUserMcpServers(text: string | undefined): McpServerEntries {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return {};
  return Object.fromEntries(Object.entries(parsed.mcpServers).filter(([, entry]) => isRecord(entry)));
}

/** Reads the user's own MCP servers. Never throws: a missing or corrupt file
 * just means the worker starts with the bridges alone. */
export function readUserMcpServers(home: string, env: NodeJS.ProcessEnv = process.env): McpServerEntries {
  const configDir = env.CLAUDE_CONFIG_DIR || home;
  try {
    return parseUserMcpServers(readFileSync(join(configDir, ".claude.json"), "utf8"));
  } catch {
    return {};
  }
}

/** One `--mcp-config` payload carrying the user's servers plus the relay's
 * bridges. A bridge wins a name clash, so a user entry can never replace the
 * relay's own `anywh-choice`/`anywh-permission`. `undefined` when there is
 * nothing to pass. */
export function mergeAgentWorkerMcpConfig(bridgeConfigJson: string | undefined, userServers: McpServerEntries): string | undefined {
  const bridgeServers = bridgeConfigJson ? (JSON.parse(bridgeConfigJson) as { mcpServers?: McpServerEntries }).mcpServers ?? {} : {};
  if (Object.keys(userServers).length === 0 && !bridgeConfigJson) return undefined;
  if (Object.keys(userServers).length === 0) return bridgeConfigJson;
  return JSON.stringify({ mcpServers: { ...userServers, ...bridgeServers } });
}
