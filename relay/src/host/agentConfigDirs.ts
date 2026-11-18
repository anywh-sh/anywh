// Where each agent CLI keeps its account and configuration for a profile.
// A profile used to isolate its account by swapping `$HOME`
// whole (`RELAY_HOME_OVERRIDE`); a profile created now keeps the real
// `$HOME` and points each CLI's own variable at a folder of its own, so
// git, SSH and the user's tools keep working. Both models coexist: a
// profile with neither falls back to `<home>/.claude` and friends, exactly
// as before.
//
// Paths elsewhere in the relay (portability manifests, context accounting,
// transcripts) are written relative to the home, the way the CLIs document
// them (`.claude/skills`, `.codex/config.toml`). `resolveAgentPath` is the
// one place that turns such a path into the file a CLI would actually read
// under a given environment.
import { join } from "node:path";

export type ConfigDirAgent = "claude" | "codex" | "kimi";

interface ConfigDirRule {
  /** The variable the CLI reads its config folder from. */
  envVar: string;
  /** The folder under `$HOME` it uses when the variable is unset. */
  homeDir: string;
  /** Files the CLI keeps next to that folder (under `$HOME`) by default,
   * but inside it when the variable is set. Claude's `~/.claude.json` is
   * the one case, measured against 2.1.323: with `CLAUDE_CONFIG_DIR` set it
   * becomes `$CLAUDE_CONFIG_DIR/.claude.json`. */
  siblingFiles: readonly string[];
}

export const CONFIG_DIR_RULES: Readonly<Record<ConfigDirAgent, ConfigDirRule>> = {
  claude: { envVar: "CLAUDE_CONFIG_DIR", homeDir: ".claude", siblingFiles: [".claude.json"] },
  codex: { envVar: "CODEX_HOME", homeDir: ".codex", siblingFiles: [] },
  kimi: { envVar: "KIMI_CODE_HOME", homeDir: ".kimi-code", siblingFiles: [] },
};

export const CONFIG_DIR_AGENTS = Object.keys(CONFIG_DIR_RULES) as ConfigDirAgent[];

export type AgentConfigDirs = Partial<Record<ConfigDirAgent, string>>;

/** The config dirs a set of env vars names (an env file, or `process.env`).
 * Empty values count as unset, as the CLIs treat them. */
export function configDirsFromEnv(env: Readonly<Record<string, string | undefined>>): AgentConfigDirs {
  const dirs: AgentConfigDirs = {};
  for (const agent of CONFIG_DIR_AGENTS) {
    const value = env[CONFIG_DIR_RULES[agent].envVar]?.trim();
    if (value) dirs[agent] = value;
  }
  return dirs;
}

/** An agent's config folder under `env`, else `<home>/<its default>`. */
export function agentConfigDir(agent: ConfigDirAgent, home: string, env: NodeJS.ProcessEnv = process.env): string {
  const rule = CONFIG_DIR_RULES[agent];
  return env[rule.envVar]?.trim() || join(home, rule.homeDir);
}

/** The absolute file a home-relative path (`.claude/projects/x`,
 * `.claude.json`, `.codex/config.toml`, `.agents/AGENTS.md`) names under
 * `env`. A path outside every agent's folder stays under the home. */
export function resolveAgentPath(home: string, relativePath: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalized = relativePath.split(/[\\/]+/).filter(Boolean);
  const [head, ...rest] = normalized;
  if (normalized.length === 0) return home;
  for (const agent of CONFIG_DIR_AGENTS) {
    const rule = CONFIG_DIR_RULES[agent];
    const dir = env[rule.envVar]?.trim();
    if (!dir) continue;
    if (head === rule.homeDir) return join(dir, ...rest);
    if (rest.length === 0 && rule.siblingFiles.includes(head)) return join(dir, head);
  }
  return join(home, ...normalized);
}

/** Who a child process acts for when it is not this relay's own profile:
 * a profile being created, or one another relay runs. `home` is a legacy
 * `$HOME` swap; `configDirs` one folder per agent CLI, real `$HOME`. */
export interface ProfileTarget {
  home?: string;
  configDirs?: AgentConfigDirs;
}

/** `env` re-aimed at `target`. Every config-dir variable is set or removed,
 * never inherited: a relay running a config-dir profile that signs in a
 * legacy one must not leak its own `CLAUDE_CONFIG_DIR` into a child whose
 * whole point is to read `<home>/.claude`. Returns a copy. */
export function envForTarget(env: NodeJS.ProcessEnv, target: ProfileTarget): NodeJS.ProcessEnv {
  const out = { ...env };
  if (target.home) out.HOME = target.home;
  for (const agent of CONFIG_DIR_AGENTS) {
    const dir = target.configDirs?.[agent];
    if (dir) out[CONFIG_DIR_RULES[agent].envVar] = dir;
    else delete out[CONFIG_DIR_RULES[agent].envVar];
  }
  return out;
}

/** The effective home and environment a `ProfileTarget` resolves to, so a
 * reader can call `resolveAgentPath(home, rel, env)` for it. */
export function resolveTarget(target: ProfileTarget, realHome: string, env: NodeJS.ProcessEnv = process.env): { home: string; env: NodeJS.ProcessEnv } {
  const targetEnv = envForTarget(env, target);
  return { home: target.home || realHome, env: targetEnv };
}
