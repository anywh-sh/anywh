import { spawn } from "node:child_process";
import { AGENT_BIN, EXTRA_PATH_DIRS, stripBilledCredentials } from "../executables.js";

// Extracts the CLI's own display name for the model in effect, versioned —
// "Current model: `Sonnet 5.5 (default)`" -> "Sonnet 5.5", "Current model:
// `Opus 5.5 (1M context)`" -> "Opus 5.5 (1M context)". Used to stop at the
// family ("Opus"), which left no way to tell which version an alias
// resolved to without opening the CLI's own picker. The backtick is
// optional: found by testing that a newer CLI version started wrapping the
// value in markdown backticks, silently breaking this probe (it always
// returned `undefined` until this was noticed). The trailing "(default)"
// marker is dropped by `parseCurrentModel`, not here.
export const CURRENT_MODEL_RE = /^Current model:\s*`?([^`\n]+?)`?\s*$/m;

// Same `result` string also lists every alias the CLI accepts, e.g.
// "Usage: /model <name>. Available: sonnet, opus, haiku, fable, best,
// sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID."
// Non-greedy up to the first period after "Available:" — confirmed by
// testing there's no other period inside the list itself.
export const AVAILABLE_MODELS_RE = /Available:\s*(.+?)(?:\.|$)/;

export interface DefaultModelInfo {
  label: string;
  available: string[];
}

/** The versioned display name out of a `/model` probe's `result`, minus the
 * "(default)" marker the CLI appends when no `--model` override is in
 * effect — `undefined` when the text doesn't carry a "Current model:" line. */
export function parseCurrentModel(result: string): string | undefined {
  const match = CURRENT_MODEL_RE.exec(result);
  if (!match) return undefined;
  const name = match[1].replace(/\s*\(default\)\s*$/i, "").trim();
  return name.length > 0 ? name : undefined;
}

/** Parses the "Available: ..." segment into individual aliases, dropping the
 * trailing "or a full model ID" filler (not a real alias) — tested against
 * both profile accounts (Sonnet-5 default and Opus-5 default) and the list
 * came back byte-for-byte identical, so this is a CLI-version catalog, not
 * an account entitlement list. */
export function parseAvailableModels(result: string): string[] {
  const match = AVAILABLE_MODELS_RE.exec(result);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !token.startsWith("or "));
}

/**
 * Spawns `claude -p /model` (optionally under `--model <alias>`) and returns
 * the `result` text. Found by testing manually: `/model` without an argument
 * is intercepted by the CLI itself before any API call (`num_turns: 0`,
 * `total_cost_usd: 0` in the result), so it costs nothing — and under
 * `--model <alias>` its "Current model:" line reports what that alias
 * resolves to right now ("opus" -> "Opus 5.5", "best" -> "Fable 5.1").
 */
async function runModelProbe(homeOverride: string | undefined, cwd: string, alias?: string): Promise<string | undefined> {
  const env = { ...process.env };
  stripBilledCredentials(env);
  if (homeOverride) env.HOME = homeOverride;
  env.PATH = [...EXTRA_PATH_DIRS, env.PATH ?? ""].join(":");

  const child = spawn(
    AGENT_BIN,
    [
      "-p",
      "/model",
      "--output-format",
      "json",
      "--no-session-persistence",
      // Same flags as titleGenerator.ts, same reason: without them, a
      // profile with MCP configured (actual finding while testing the work
      // profile) prints a stray log line on stdout AFTER the JSON (something
      // like "Client. listTools() called but server does not advertise
      // tools capability"), breaking the parse below even with exit code 0.
      "--tools",
      "",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      ...(alias ? ["--model", alias] : []),
    ],
    { env, cwd },
  );

  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0) return undefined;

  // Extra defense beyond the flags above: the result always comes on a
  // single line (confirmed by testing), so ignore anything that still leaks
  // after it instead of trying to `JSON.parse` the whole stdout.
  let parsed: { result?: unknown };
  try {
    parsed = JSON.parse(stdout.split("\n")[0] ?? "") as { result?: unknown };
  } catch {
    return undefined;
  }
  return typeof parsed.result === "string" ? parsed.result : undefined;
}

/**
 * Runs once at relay boot (server.ts) to find out this profile account's
 * actual default model (see `runModelProbe` for why it's free). Each
 * profile runs its own relay process with its own `$HOME` so each instance
 * only probes its own account.
 *
 * The actual finding that motivated this: the two profiles have DIFFERENT
 * defaults — personal came back "Sonnet 5 (default)", work came back "Opus 5
 * (1M context) (default)". There was no way to assume a fixed value (e.g.
 * always "Opus") without showing a wrong label for at least one of the two.
 *
 * The same probe also returns the full model catalog (`available`) straight
 * from the CLI's own usage text, instead of a hardcoded list that goes stale
 * whenever a new alias ships.
 */
export async function detectDefaultModel(
  homeOverride: string | undefined,
  cwd: string,
): Promise<DefaultModelInfo | undefined> {
  const result = await runModelProbe(homeOverride, cwd);
  if (result === undefined) return undefined;
  const label = parseCurrentModel(result);
  if (!label) return undefined;
  return { label, available: parseAvailableModels(result) };
}

/** How many alias probes run at once. Each one is a full `claude` CLI
 * process (a Node runtime of its own), and all nine firing together at boot
 * is a memory and CPU spike on a small self-hosted box — twice over with
 * two profiles restarting side by side. */
const ALIAS_PROBE_CONCURRENCY = 3;

/**
 * What each alias resolves to right now ("opus" -> "Opus 5.5") — one probe
 * per alias, `ALIAS_PROBE_CONCURRENCY` at a time. Kept apart from
 * `detectDefaultModel` because it's slow in aggregate (seconds for the nine
 * aliases the CLI ships today), and the default label shouldn't wait on it. "default" is
 * skipped: it's the "no override" meta-value, already covered by
 * `DefaultModelInfo.label`. An alias whose probe fails is just left out —
 * the picker falls back to its bare label for it.
 */
export async function resolveModelAliases(
  homeOverride: string | undefined,
  cwd: string,
  aliases: string[],
): Promise<Record<string, string>> {
  const pending = aliases.filter((alias) => alias !== "default");
  const resolved: Record<string, string> = {};
  const worker = async () => {
    for (let alias = pending.shift(); alias !== undefined; alias = pending.shift()) {
      const result = await runModelProbe(homeOverride, cwd, alias).catch(() => undefined);
      const name = result === undefined ? undefined : parseCurrentModel(result);
      if (name) resolved[alias] = name;
    }
  };
  await Promise.all(Array.from({ length: ALIAS_PROBE_CONCURRENCY }, worker));
  return resolved;
}
