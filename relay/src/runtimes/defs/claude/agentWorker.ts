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
//   - Servers the user switched off for this directory
//     (`projects[cwd].disabledMcpServers`) are not passed on.
//
// Known cost of `project,local`: it ALSO skips the user's
// ~/.claude/settings.json, so a worker does not get the user's `env`,
// `permissions`, `apiKeyHelper`, default `model` or any other key kept
// there. Someone who authenticates through `apiKeyHelper` or provider
// variables defined in that file (Bedrock/Vertex style) will have workers
// that cannot authenticate; OAuth logins and variables already in the
// relay's own environment are unaffected. Those keys are deliberately not
// forwarded here.
//
// The server entries carry secrets (Authorization headers, `*_KEY` env), so
// they must never reach argv, where `ps` and /proc/<pid>/cmdline expose them:
// the merged config goes into a private temp file and only its path is passed.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AGENT_WORKER_SETTING_SOURCES = "project,local";

type McpServerEntries = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The user-scope `mcpServers` map out of the text of ~/.claude.json, minus
 * the servers disabled for `cwd`. Entries that are not objects are dropped;
 * anything unparsable yields no servers. */
export function parseUserMcpServers(text: string | undefined, cwd?: string): McpServerEntries {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return {};
  const disabled = new Set<string>();
  const addDisabled = (list: unknown): void => {
    if (Array.isArray(list)) for (const name of list) if (typeof name === "string") disabled.add(name);
  };
  addDisabled(parsed.disabledMcpServers);
  const project = cwd !== undefined && isRecord(parsed.projects) ? parsed.projects[cwd] : undefined;
  if (isRecord(project)) addDisabled(project.disabledMcpServers);
  return Object.fromEntries(Object.entries(parsed.mcpServers).filter(([name, entry]) => isRecord(entry) && !disabled.has(name)));
}

// One entry per config file: ~/.claude.json is big and every worker turn would
// otherwise re-read and re-parse it. Keyed by path, valid while mtime+size hold.
const fileCache = new Map<string, { mtimeMs: number; size: number; text: string }>();

async function readConfigText(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    const cached = fileCache.get(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.text;
    const text = await readFile(path, "utf8");
    fileCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text });
    return text;
  } catch {
    return undefined;
  }
}

/** Reads the user's own MCP servers. Never throws: a missing or corrupt file
 * just means the worker starts with the bridges alone. */
export async function readUserMcpServers(home: string, cwd?: string, env: NodeJS.ProcessEnv = process.env): Promise<McpServerEntries> {
  const configDir = env.CLAUDE_CONFIG_DIR || home;
  return parseUserMcpServers(await readConfigText(join(configDir, ".claude.json")), cwd);
}

/** One `--mcp-config` payload carrying the user's servers plus the relay's
 * bridges. A bridge wins a name clash, so a user entry can never replace the
 * relay's own `anywh-choice`/`anywh-permission`. Other top-level keys of the
 * bridge config are kept. `undefined` when there is nothing to pass. */
export function mergeAgentWorkerMcpConfig(bridgeConfigJson: string | undefined, userServers: McpServerEntries): string | undefined {
  if (Object.keys(userServers).length === 0) return bridgeConfigJson;
  const bridge = bridgeConfigJson ? (JSON.parse(bridgeConfigJson) as Record<string, unknown>) : {};
  const bridgeServers = isRecord(bridge.mcpServers) ? bridge.mcpServers : {};
  return JSON.stringify({ ...bridge, mcpServers: { ...userServers, ...bridgeServers } });
}

const CONFIG_DIR_PREFIX = "anywh-worker-mcp-";
const STALE_AFTER_MS = 60 * 60 * 1000;

export interface AgentWorkerMcpFile {
  path: string;
  /** Idempotent. */
  remove: () => Promise<void>;
}

/** Writes `configJson` to `<tmp>/anywh-worker-mcp-XXXX/mcp.json`, directory
 * 0700 and file 0600. */
export async function writeAgentWorkerMcpFile(configJson: string): Promise<AgentWorkerMcpFile> {
  const dir = await mkdtemp(join(tmpdir(), CONFIG_DIR_PREFIX));
  await chmod(dir, 0o700);
  const path = join(dir, "mcp.json");
  await writeFile(path, configJson, { mode: 0o600 });
  return { path, remove: () => rm(dir, { recursive: true, force: true }) };
}

let swept = false;

/** Removes config dirs a previous relay left behind (killed mid-turn). Runs
 * once per process; only touches our own prefix and only old entries. */
export async function sweepStaleAgentWorkerMcpFiles(now: number = Date.now()): Promise<void> {
  if (swept) return;
  swept = true;
  try {
    const root = tmpdir();
    await mkdir(root, { recursive: true });
    for (const name of await readdir(root)) {
      if (!name.startsWith(CONFIG_DIR_PREFIX)) continue;
      const path = join(root, name);
      try {
        if (now - (await stat(path)).mtimeMs > STALE_AFTER_MS) await rm(path, { recursive: true, force: true });
      } catch {
        // raced with another cleanup; nothing to do
      }
    }
  } catch {
    // best effort
  }
}
