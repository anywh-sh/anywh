import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { resolveShipped } from "../host/paths.js";

// Shared by every module that spawns the agent CLI (the real turn in
// runtimes/defs/claude/session.ts, plus the one-shot probes in defaultModel.ts,
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
const CONFIGURED_AGENT_BIN = process.env.AGENT_BIN ?? process.env.CLAUDE_BIN ?? "claude";

// Where a CLI installed for one user lands when the relay's own PATH
// doesn't have it. Not a guess at one product's installer: these are the
// per-user and package-manager bin directories a CLI installs into, and
// what is looked for in them is whatever AGENT_BIN names — an agent that
// isn't this one, installed the same way, is found the same way.
const WELL_KNOWN_BIN_DIRS = [join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent CLI as something `spawn` can actually find.
 *
 * A bare name is only spawnable if it's on the PATH the relay runs with,
 * and a relay started by a service manager doesn't run with the user's:
 * launchd hands it `/usr/bin:/bin:/usr/sbin:/sbin`, and a systemd user
 * manager's default is barely wider — neither includes `~/.local/bin`,
 * where the agent CLI installs by default, and neither sources the shell
 * profile that would have added it. That is a relay that comes up
 * perfectly, serves the UI, and fails every turn with `spawn claude
 * ENOENT` for a binary sitting right there.
 *
 * Resolved at the point of use rather than pinned at install time on
 * purpose: the agent CLI may be installed after the relay (nothing in the
 * install requires it up front), and this way it is simply found the next
 * time a turn runs, with no re-provisioning.
 *
 * A name with a separator in it is returned untouched — the operator said
 * exactly which binary. A name already on PATH is returned as the bare
 * name it was, so the overwhelmingly common case (a relay started from a
 * shell) behaves exactly as it did.
 */
export function resolveAgentBin(name: string, env: NodeJS.ProcessEnv = process.env, dirs: readonly string[] = WELL_KNOWN_BIN_DIRS): string {
  if (isAbsolute(name) || name.includes(sep)) return name;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && isExecutable(join(dir, name))) return name;
  }
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  // Nothing found. Deliberately not an error: the relay's job is to be up
  // and serving whether or not an agent CLI exists yet, and the honest
  // place to report that it doesn't is the turn that tried to spawn it.
  return name;
}

export const AGENT_BIN = resolveAgentBin(CONFIGURED_AGENT_BIN);

// Credentials that make a spawned agent bill per token instead of drawing on
// the subscription its CLI is already logged into. Removed from the
// environment of every child this relay spawns: the turn itself, the one-shot
// probes, and the interactive terminal — a terminal the user opened can run
// the agent manually just as well.
//
// Scoped to the providers whose CLIs this relay actually spawns, not every
// provider that exists. A blanket `*_API_KEY` sweep would also strip a key a
// project's own tooling legitimately needs inside a turn, which is not this
// rule's business. Teaching the relay a second agent CLI means adding that
// provider's credentials here, alongside it — `OPENAI_API_KEY` is Codex's:
// `defs/codex.ts`'s own `identity.env.strip` already covers the daemon spawn
// (`codexDaemon.ts`), but the interactive terminal and the one-shot probes
// go through `stripBilledCredentials` below, not a def's own env — without
// this entry, a `codex` run by hand in the app's embedded terminal on a
// machine with `OPENAI_API_KEY` set would bill per token instead of drawing
// on the CLI's own subscription.
export const BILLED_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"] as const;

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
export const SCRIPTS_DIR = resolveShipped(import.meta.url, "../../scripts", "scripts");

// Prepended to every spawned child's PATH. `EXTRA_PATH_DIRS` env var is
// colon-separated, for any tool the child invokes that isn't already on the
// relay process's own PATH (e.g. a Node version manager's shim dir under
// systemd).
// The agent CLI's own directory rides along when AGENT_BIN resolved to a
// path: a CLI found outside the relay's PATH can still re-invoke itself,
// or a sibling tool it ships with, by bare name — and the child's PATH is
// the relay's, which by construction is the one that didn't have it.
const agentBinDir = AGENT_BIN.includes(sep) ? dirname(AGENT_BIN) : "";

export const EXTRA_PATH_DIRS = [...configuredExtraPathDirs, ...(agentBinDir ? [agentBinDir] : []), SCRIPTS_DIR];
