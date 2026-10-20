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
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AGENT_WORKER_SETTING_SOURCES = "project,local";

type McpServerEntries = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What is kept of ~/.claude.json: the user-scope servers and the disabled
 * lists, never the raw text. */
interface UserMcpConfig {
  servers: McpServerEntries;
  disabled: string[];
  disabledByProject: Record<string, string[]>;
}

const NO_CONFIG: UserMcpConfig = { servers: {}, disabled: [], disabledByProject: {} };

function nameList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

function extractUserMcpConfig(text: string): UserMcpConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NO_CONFIG;
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return NO_CONFIG;
  const disabledByProject: Record<string, string[]> = {};
  if (isRecord(parsed.projects)) {
    for (const [dir, project] of Object.entries(parsed.projects)) {
      if (isRecord(project)) {
        const names = nameList(project.disabledMcpServers);
        if (names.length > 0) disabledByProject[dir] = names;
      }
    }
  }
  return {
    servers: Object.fromEntries(Object.entries(parsed.mcpServers).filter(([, entry]) => isRecord(entry))),
    disabled: nameList(parsed.disabledMcpServers),
    disabledByProject,
  };
}

function selectServers(config: UserMcpConfig, cwd: string | undefined): McpServerEntries {
  const disabled = new Set([...config.disabled, ...(cwd !== undefined ? (config.disabledByProject[cwd] ?? []) : [])]);
  return Object.fromEntries(Object.entries(config.servers).filter(([name]) => !disabled.has(name)));
}

/** The user-scope `mcpServers` map out of the text of ~/.claude.json, minus
 * the servers disabled for `cwd`. Entries that are not objects are dropped;
 * anything unparsable yields no servers. */
export function parseUserMcpServers(text: string | undefined, cwd?: string): McpServerEntries {
  return text === undefined ? {} : selectServers(extractUserMcpConfig(text), cwd);
}

// One entry per config file: ~/.claude.json is big and every worker turn would
// otherwise re-read and re-parse it. Valid while mtime+size hold. Only the
// extracted result is kept, never the file's text.
const fileCache = new Map<string, { mtimeMs: number; size: number; config: UserMcpConfig }>();

async function readUserMcpConfig(path: string): Promise<UserMcpConfig> {
  try {
    const info = await stat(path);
    const cached = fileCache.get(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.config;
    const config = extractUserMcpConfig(await readFile(path, "utf8"));
    fileCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, config });
    return config;
  } catch {
    return NO_CONFIG;
  }
}

/** Reads the user's own MCP servers. Never throws: a missing or corrupt file
 * just means the worker starts with the bridges alone. */
export async function readUserMcpServers(home: string, cwd?: string, env: NodeJS.ProcessEnv = process.env): Promise<McpServerEntries> {
  const configDir = env.CLAUDE_CONFIG_DIR || home;
  return selectServers(await readUserMcpConfig(join(configDir, ".claude.json")), cwd);
}

/** One `--mcp-config` payload carrying the user's servers plus the relay's
 * bridges. A bridge wins a name clash, so a user entry can never replace the
 * relay's own `anywh-choice`/`anywh-permission`. Other top-level keys of the
 * bridge config are kept. `undefined` when there is nothing to pass. */
export function mergeAgentWorkerMcpConfig(bridgeConfigJson: string | undefined, userServers: McpServerEntries): string | undefined {
  if (Object.keys(userServers).length === 0) return bridgeConfigJson;
  let bridge: Record<string, unknown> = {};
  if (bridgeConfigJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bridgeConfigJson);
    } catch {
      return bridgeConfigJson;
    }
    // Not an object we can merge into: pass the bridge text through untouched.
    if (!isRecord(parsed)) return bridgeConfigJson;
    bridge = parsed;
  }
  const bridgeServers = isRecord(bridge.mcpServers) ? bridge.mcpServers : {};
  return JSON.stringify({ ...bridge, mcpServers: { ...userServers, ...bridgeServers } });
}

// The owner's pid is part of the name so one relay's sweep never removes the
// directory of a worker another relay profile still has running.
const CONFIG_DIR_PREFIX = "anywh-worker-mcp-";

export interface AgentWorkerMcpFile {
  path: string;
  /** Idempotent. */
  remove: () => Promise<void>;
}

/** Writes `configJson` to `<tmp>/anywh-worker-mcp-<pid>-XXXX/mcp.json`. The
 * directory is created 0700 by `mkdtemp`, the file 0600. */
export async function writeAgentWorkerMcpFile(configJson: string): Promise<AgentWorkerMcpFile> {
  const dir = await mkdtemp(join(tmpdir(), `${CONFIG_DIR_PREFIX}${process.pid}-`));
  const path = join(dir, "mcp.json");
  try {
    await writeFile(path, configJson, { mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { path, remove: () => rm(dir, { recursive: true, force: true }) };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, we just may not signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

let swept = false;

/** Removes config dirs whose owning process is gone (a relay killed
 * mid-turn). Runs once per process; only touches our own prefix. */
export async function sweepStaleAgentWorkerMcpFiles(): Promise<void> {
  if (swept) return;
  swept = true;
  try {
    const root = tmpdir();
    for (const name of await readdir(root)) {
      const match = new RegExp(`^${CONFIG_DIR_PREFIX}(\\d+)-`).exec(name);
      if (!match || processIsAlive(Number(match[1]))) continue;
      await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // best effort
  }
}
