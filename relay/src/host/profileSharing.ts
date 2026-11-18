// What a new profile with its own config folders keeps from the machine's
// own agent configuration (`~/.claude`, `~/.codex`, `~/.kimi-code`). The
// account is never shared — that is what the folders are for. Everything
// else is the user's choice, per category:
//
//   - separate: the profile starts empty and keeps its own.
//   - shared:   the profile's entry is a symlink to the machine's, so an edit
//               on either side is the same file.
//   - copy:     a one-time copy, after which the two drift apart.
//
// A link points at the machine's folder, never at another profile's, so
// deleting a profile can never break another one.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_AGENTS, type ConfigDirAgent } from "./agentConfigDirs.js";

export const SHARING_CATEGORIES = ["instructions", "preferences", "mcp"] as const;
export type SharingCategory = (typeof SHARING_CATEGORIES)[number];
export const SHARING_MODES = ["separate", "shared", "copy"] as const;
export type SharingMode = (typeof SHARING_MODES)[number];
export type ProfileSharing = Record<SharingCategory, SharingMode>;

export const SEPARATE_EVERYTHING: ProfileSharing = { instructions: "separate", preferences: "separate", mcp: "separate" };

interface Entry {
  /** Relative to the agent's config folder. */
  readonly path: string;
  readonly kind: "file" | "dir";
}

/**
 * Which entries of each agent's config folder belong to which category.
 * Absent means the category can't be shared for that agent:
 *
 *   - Claude keeps its MCP servers in `.claude.json`, next to the account,
 *     so MCP is not a file here; a shared choice is honored at spawn time
 *     instead (`ANYWH_CLAUDE_SHARED_MCP`), a copy merges the one key.
 *     `plugins` sits with preferences because `settings.json` is what
 *     enables them.
 *   - Codex keeps preferences and MCP servers in the one `config.toml`, so
 *     the file follows the MCP choice and preferences have no entry.
 *   - Kimi's `config.toml` holds its provider keys and OAuth references, so
 *     it is the account: Kimi preferences are always separate.
 */
const ENTRIES: Readonly<Record<ConfigDirAgent, Partial<Record<SharingCategory, readonly Entry[]>>>> = {
  claude: {
    instructions: [
      { path: "CLAUDE.md", kind: "file" },
      { path: "skills", kind: "dir" },
      { path: "agents", kind: "dir" },
      { path: "commands", kind: "dir" },
    ],
    preferences: [
      { path: "settings.json", kind: "file" },
      { path: "plugins", kind: "dir" },
    ],
  },
  codex: {
    instructions: [
      { path: "AGENTS.md", kind: "file" },
      { path: "skills", kind: "dir" },
      { path: "prompts", kind: "dir" },
    ],
    mcp: [{ path: "config.toml", kind: "file" }],
  },
  kimi: {
    instructions: [
      { path: "AGENTS.md", kind: "file" },
      { path: "skills", kind: "dir" },
      { path: "agents", kind: "dir" },
    ],
    mcp: [{ path: "mcp.json", kind: "file" }],
  },
};

/** The env var (and value) a profile needs at runtime for its choices. */
export interface SharingRuntimeEnv {
  readonly ANYWH_CLAUDE_SHARED_MCP?: string;
}

/**
 * Applies `sharing` to a profile's config folders. `source` is the machine's
 * own folder per agent; `claudeJson` the machine's `~/.claude.json` (it sits
 * outside `~/.claude`). Idempotent for `shared` (a link already there is left
 * alone); `copy` never overwrites what the profile already has.
 *
 * Returns the env the profile's relay needs for the parts that aren't files.
 */
export function applyProfileSharing(
  sharing: ProfileSharing,
  target: Readonly<Record<ConfigDirAgent, string>>,
  source: Readonly<Record<ConfigDirAgent, string>>,
  claudeJson: string,
): SharingRuntimeEnv {
  for (const agent of CONFIG_DIR_AGENTS) {
    for (const category of SHARING_CATEGORIES) {
      const mode = sharing[category];
      if (mode === "separate") continue;
      for (const entry of ENTRIES[agent][category] ?? []) {
        const from = join(source[agent], entry.path);
        const to = join(target[agent], entry.path);
        if (mode === "shared") link(from, to, entry.kind);
        else copy(from, to);
      }
    }
  }
  if (sharing.mcp === "copy") copyClaudeMcpServers(claudeJson, join(target.claude, ".claude.json"));
  return sharing.mcp === "shared" ? { ANYWH_CLAUDE_SHARED_MCP: claudeJson } : {};
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A folder is created on the machine's side first, so both sides can add
 * to it; a missing file is linked anyway — the first write through the link
 * creates it where it belongs. */
function link(from: string, to: string, kind: Entry["kind"]): void {
  if (kind === "dir") mkdirSync(from, { recursive: true });
  if (exists(to)) {
    if (lstatSync(to).isSymbolicLink()) return;
    // Only an empty folder is replaced: anything with content is the
    // profile's own, and a share never deletes it.
    if (!lstatSync(to).isDirectory()) return;
    try {
      rmSync(to, { recursive: false });
    } catch {
      return;
    }
  }
  mkdirSync(dirname(to), { recursive: true });
  symlinkSync(from, to);
}

function copy(from: string, to: string): void {
  if (!existsSync(from) || exists(to)) return;
  mkdirSync(dirname(to), { recursive: true });
  // Links inside a skill folder stay links: this is the same machine, and
  // following them could pull in whatever they point at.
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/** Merges the machine's user-scope `mcpServers` into the profile's
 * `.claude.json`, keeping every other key the profile's own Claude wrote
 * there (its account among them). A server the profile already has wins. */
function copyClaudeMcpServers(from: string, to: string): void {
  const servers = readMcpServers(from);
  if (Object.keys(servers).length === 0) return;
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(to, "utf8"));
    if (isRecord(parsed)) existing = parsed;
  } catch {
    // No file yet: the profile's Claude hasn't run.
  }
  const own = isRecord(existing.mcpServers) ? existing.mcpServers : {};
  writeFileSync(to, JSON.stringify({ ...existing, mcpServers: { ...servers, ...own } }, null, 2), { mode: 0o600 });
}

function readMcpServers(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProfileSharing(value: unknown): value is ProfileSharing {
  if (!isRecord(value)) return false;
  return SHARING_CATEGORIES.every((category) => (SHARING_MODES as readonly unknown[]).includes(value[category]));
}
