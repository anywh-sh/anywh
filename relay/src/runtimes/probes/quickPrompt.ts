import { spawn } from "node:child_process";
import { dirname, sep } from "node:path";
import { buildChildEnv } from "../../host/childEnv.js";
import { EXTRA_PATH_DIRS, resolveAgentBin, stripBilledCredentials } from "../executables.js";
import type { AgentRuntimeDef } from "../types.js";

export interface QuickPromptResult {
  readonly stdout: string;
  readonly exitCode: number | null;
}

/**
 * Runs a short, isolated one-shot prompt against whichever CLI `def`
 * describes — the shared spawn behind every probe (title/suggestion
 * generation) that needs a quick answer from an agent without a real turn.
 * `undefined` when `def.quickPrompt.kind === "none"`, so the caller can fall
 * back honestly instead of this file guessing at a mode the CLI doesn't have.
 *
 * Resolves `def.identity.bin` the same way every real spawn does
 * (`resolveAgentBin`) rather than the global `AGENT_BIN`, which only ever
 * names Claude — a probe running against Codex needs Codex's own binary,
 * found the same way `codexDaemon.ts` finds it for a real turn.
 *
 * Spawned with the session's real `cwd`, not the relay's own — a CLI that
 * auto-discovers project instructions from the working directory (Claude's
 * `CLAUDE.md`, Codex's `AGENTS.md`) picks up the wrong project's otherwise.
 * Real finding pre-dating this shared runner: asking for a title for a
 * session in `~/mode/storefront` while running under systemd (whose
 * `WorkingDirectory` is this repo) came back "anywh wrapper Claude
 * multiplataforma" — about anywh, not storefront — until the spawn's `cwd`
 * was pinned to the session's own folder.
 *
 * `stdio`'s stdin is explicitly `"ignore"`, not the default open pipe:
 * confirmed live that `codex exec` (unlike `claude -p`) treats a
 * still-open, never-written stdin pipe as "more input may be appended", and
 * blocks forever waiting for an EOF nothing would ever send — reproduced
 * with a real spawn before this fix (`timeout 30` killed it every time),
 * fixed by the same spawn call every def's quick prompt now shares.
 * `claude -p` doesn't share that behavior, but ignoring stdin costs it
 * nothing either.
 */
export async function runQuickPrompt(
  def: AgentRuntimeDef,
  homeOverride: string | undefined,
  cwd: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<QuickPromptResult | undefined> {
  if (def.quickPrompt.kind === "none") return undefined;

  const bin = resolveAgentBin(def.identity.bin);
  // Same reasoning as executables.ts's own `agentBinDir`: a binary found
  // outside the relay's PATH (WELL_KNOWN_BIN_DIRS) can still re-invoke
  // itself or a sibling tool by bare name, and the child's PATH is the
  // relay's own, which by construction is the one that didn't have it.
  const binDir = bin.includes(sep) ? dirname(bin) : undefined;
  const pathDirs = binDir ? [...EXTRA_PATH_DIRS, binDir] : EXTRA_PATH_DIRS;
  const env = buildChildEnv(homeOverride, pathDirs, stripBilledCredentials);
  const args = def.quickPrompt.buildArgs({ systemPrompt, userPrompt, cwd });

  const child = spawn(bin, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  return { stdout, exitCode };
}
