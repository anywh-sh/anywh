import { resolveShipped } from "./paths.js";

// Shared by every module that spawns the agent CLI (the real turn in
// claudeSession.ts, plus the one-shot probes in defaultModel.ts,
// titleGenerator.ts, suggestionGenerator.ts) — same binary, same PATH
// problem for all of them.
//
// Absolute path and explicit PATH: running via systemd the process doesn't
// have the user's interactive shell PATH (doesn't source .bashrc/.profile),
// so neither the binary nor tools it invokes internally (node, git...) would
// be found by name alone — same bug class already fixed for tmux.
// Defaults to the bare command name, which works whenever the relay itself
// is started from a shell that already has the agent CLI on PATH (e.g. `npm
// run dev`); override via env for systemd or any other PATH-less launch.
//
// `CLAUDE_BIN` is the pre-rename name, still honored so an existing
// deployment's .env keeps working across an upgrade without being edited.
// It is deprecated: `AGENT_BIN` is the documented name, and the fallback
// chain below is the only place that should ever mention the old one.
export const AGENT_BIN = process.env.AGENT_BIN ?? process.env.CLAUDE_BIN ?? "claude";

// Credentials that make a spawned agent bill per token instead of drawing on
// the subscription its CLI is already logged into. Removed from the
// environment of every child this relay spawns: the turn itself, the one-shot
// probes, and the interactive terminal — a terminal the user opened can run
// the agent manually just as well.
//
// Scoped to the provider whose CLI this relay actually spawns, not every
// provider that exists. A blanket `*_API_KEY` sweep would also strip a key a
// project's own tooling legitimately needs inside a turn, which is not this
// rule's business. Teaching the relay a second agent CLI means adding that
// provider's credentials here, alongside it.
export const BILLED_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** Strips every billed credential from `env`, in place. */
export function stripBilledCredentials(env: NodeJS.ProcessEnv): void {
  for (const name of BILLED_CREDENTIAL_VARS) {
    delete env[name];
  }
}

const configuredExtraPathDirs = (process.env.EXTRA_PATH_DIRS ?? "")
  .split(":")
  .filter((dir) => dir.length > 0);

// `relay/scripts` (not `dist/` nor `src/`) — the helper is a standalone bash
// script, doesn't need a build, and stays on PATH so a turn finds
// `anywh-bg` by name alone. Resolved relative to this file, not hardcoded,
// so it works running from `src/` (tsx), `dist/` (tsc build, one level
// below `relay/`) or the macOS SEA binary (`scripts/` shipped flat next to
// it) alike — see `resolveShipped` in paths.ts.
const SCRIPTS_DIR = resolveShipped(import.meta.url, "../scripts", "scripts");

// Prepended to every spawned child's PATH. `EXTRA_PATH_DIRS` env var is
// colon-separated, for any tool the child invokes that isn't already on the
// relay process's own PATH (e.g. a Node version manager's shim dir under
// systemd).
export const EXTRA_PATH_DIRS = [...configuredExtraPathDirs, SCRIPTS_DIR];
