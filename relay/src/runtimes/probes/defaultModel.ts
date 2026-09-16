import { spawn } from "node:child_process";
import { AGENT_BIN, EXTRA_PATH_DIRS, stripBilledCredentials } from "../executables.js";

// Extracts just the model family — "Current model: `Sonnet 5 (default)`" ->
// "Sonnet", "Current model: `Opus 5 (1M context) (default)`" -> "Opus". The
// backtick is optional: found by testing that a newer CLI version started
// wrapping the value in markdown backticks, silently breaking this probe
// (it always returned `undefined` until this was noticed). Same vocabulary
// as MODEL_LABELS on the client, so the text already arrives
// ready to display without remapping it there.
const MODEL_NAME_RE = /^Current model:\s*`?(Sonnet|Opus|Haiku|Fable)\b/i;

// Same `result` string also lists every alias the CLI accepts, e.g.
// "Usage: /model <name>. Available: sonnet, opus, haiku, fable, best,
// sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID."
// Non-greedy up to the first period after "Available:" — confirmed by
// testing there's no other period inside the list itself.
const AVAILABLE_MODELS_RE = /Available:\s*(.+?)(?:\.|$)/;

export interface DefaultModelInfo {
  label: string;
  available: string[];
}

/** Parses the "Available: ..." segment into individual aliases, dropping the
 * trailing "or a full model ID" filler (not a real alias) — tested against
 * both profile accounts (Sonnet-5 default and Opus-5 default) and the list
 * came back byte-for-byte identical, so this is a CLI-version catalog, not
 * an account entitlement list. */
function parseAvailableModels(result: string): string[] {
  const match = AVAILABLE_MODELS_RE.exec(result);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !token.startsWith("or "));
}

/**
 * Runs once at relay boot (server.ts) to find out this profile account's
 * actual default model — found by testing manually: `/model`
 * without an argument is intercepted by the CLI itself before any API call
 * (`num_turns: 0` in the result), so it costs nothing and runs in
 * ~100-200ms. Each profile runs its own relay process with its own `$HOME`
 * so each instance only probes its own account.
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

  const result = parsed.result;
  if (typeof result !== "string") return undefined;
  const match = MODEL_NAME_RE.exec(result);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  return {
    label: name.charAt(0).toUpperCase() + name.slice(1),
    available: parseAvailableModels(result),
  };
}
