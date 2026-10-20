// The MCP servers the user declared for Codex (`mcp_servers` of
// `$CODEX_HOME/config.toml`, `~/.codex/config.toml` by default), by name —
// what a room's Codex principal must have switched off, since Codex's
// app-server loads them into every thread it runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

/** Names only; never throws (a missing or broken file means none). */
export function userCodexMcpServers(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(join(env.CODEX_HOME || join(home, ".codex"), "config.toml"), "utf8");
  } catch {
    return [];
  }
  try {
    const servers = (parse(text) as { mcp_servers?: unknown }).mcp_servers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}
