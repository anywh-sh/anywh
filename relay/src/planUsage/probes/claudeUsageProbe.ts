// The minimal Claude probe: one `claude -p` turn whose only purpose is the
// `rate_limit_event` the CLI emits after the reply (journal/99 §1.3). It is a
// real turn on the user's subscription — tiny (≈570 cached tokens, ≈2 s) but
// real — so three rules hold here, whatever the caller decides:
//
// - it never runs without `claude auth status` first reporting a claude.ai
//   login: no login → `signed_out`, any other auth method (API key, Bedrock…)
//   → `no_subscription`, and in both cases nothing is spawned. With an API
//   key winning over OAuth the probe would bill per token and carry no
//   windows (journal/99 §1.5);
// - the child's env goes through `stripBilledCredentials`, like every other
//   spawn of the relay, and its cwd is an empty directory of the relay's own,
//   so no project's CLAUDE.md is loaded;
// - nothing it reads is logged or returned raw: the CLI's stdout can carry
//   the account's text, so only the parsed reading leaves this file.
//
// It never refreshes a token either: an auth failure is reported as
// `signed_out`, and logging in again is the user's move.
//
// WHEN to probe is not decided here. A probe with the 5h window expired opens
// a new one (journal/99 §1.4), and that gate (`shouldAutoProbe`, the refresh
// button's `force`) belongs to the scheduler. This file only knows how.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { sessionsRoot } from "../../agentHost/paths.js";
import { buildChildEnv } from "../../host/childEnv.js";
import { claudeRuntimeDef } from "../../runtimes/defs/claude/index.js";
import { EXTRA_PATH_DIRS, resolveAgentBin, stripBilledCredentials } from "../../runtimes/executables.js";
import { claudeReadingStatus, parseClaudeRateLimitEvent, type ClaudeRateLimitStatus } from "../claudeEvent.js";
import type { PlanUsageReading } from "../ingest.js";
import { claudePlanLabel } from "../planLabel.js";
import type { PlanUsageErrorKind } from "../types.js";
import { isRecord } from "../windows.js";

/** The flags of journal/99 §1.3, measured against Claude Code 2.1.303:
 * `--no-session-persistence` leaves no transcript behind (so the probe never
 * shows up as local activity), `--safe-mode` drops the user's CLAUDE.md,
 * hooks, plugins and MCP while keeping OAuth (`--bare` would drop OAuth too),
 * and the rest keep the turn as small as a turn gets. */
export const CLAUDE_USAGE_PROBE_ARGS: readonly string[] = [
  "-p",
  "ok",
  "--output-format",
  "stream-json",
  "--verbose",
  "--model",
  "haiku",
  "--tools",
  "",
  "--no-session-persistence",
  "--max-turns",
  "1",
  "--safe-mode",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--system-prompt",
  "Reply with the single word ok.",
];

/** The probe takes 1.5–3 s; past this, something is wrong with the network
 * or the CLI, and the last reading is worth more than waiting. */
export const CLAUDE_USAGE_PROBE_TIMEOUT_MS = 30_000;
const AUTH_STATUS_TIMEOUT_MS = 5_000;

/** `claude auth status --json`, the fields this probe reads. Relay-internal:
 * `email` and `orgId` identify the account and must never reach the client,
 * a log or the persisted snapshot — the opaque `accountKey` exists for that. */
export interface ClaudeUsageAuth {
  loggedIn: boolean;
  /** `"claude.ai"` for a subscription login; anything else has no plan. */
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  email?: string;
  orgId?: string;
}

export type ClaudeUsageProbeResult =
  /** The probe ran and the CLI reported the windows. */
  | { kind: "reading"; reading: PlanUsageReading; claudeStatus: ClaudeRateLimitStatus | null; auth: ClaudeUsageAuth }
  /** No subscription to read: either the pre-check said so (`probed:
   * false`, nothing was spawned) or the probe itself failed on auth. */
  | { kind: "auth"; status: "signed_out" | "no_subscription"; probed: boolean; auth?: ClaudeUsageAuth }
  /** Couldn't tell: the last reading stays (`ingestError`). */
  | { kind: "error"; error: PlanUsageErrorKind; probed: boolean };

export interface ProcessOutput {
  stdout: string;
  exitCode: number | null;
}

/** What the probe spawns, injectable so a test can stand in for the CLI
 * without touching a process. */
export interface ClaudeUsageProbeDeps {
  /** `claude auth status --json`'s stdout, parsed. Rejects when it couldn't
   * be read. */
  readAuthStatus: (homeOverride: string | undefined) => Promise<ClaudeUsageAuth>;
  /** Runs the probe turn; rejects on a spawn failure or timeout. */
  runProbe: (homeOverride: string | undefined, args: readonly string[]) => Promise<ProcessOutput>;
  now: () => number;
}

/** Parses `claude auth status --json`. Throws on anything that isn't a JSON
 * object with a boolean `loggedIn` — an unreadable reply is "couldn't
 * check", never "logged out". */
export function parseClaudeUsageAuth(stdout: string): ClaudeUsageAuth {
  const raw: unknown = JSON.parse(stdout);
  if (!isRecord(raw) || typeof raw.loggedIn !== "boolean") throw new Error("unexpected auth status shape");
  const auth: ClaudeUsageAuth = { loggedIn: raw.loggedIn };
  for (const key of ["authMethod", "apiProvider", "subscriptionType", "email", "orgId"] as const) {
    const value = raw[key];
    if (typeof value === "string") auth[key] = value;
  }
  return auth;
}

/** Whether `auth` allows a probe. Only a claude.ai login does: a missing
 * `authMethod` is not taken as one, since the probe would then bill an API
 * key the strip didn't catch (`apiKeyHelper`, `settings.json` env). */
export function claudeUsageAuthGate(auth: ClaudeUsageAuth): "probe" | "signed_out" | "no_subscription" {
  if (!auth.loggedIn) return "signed_out";
  return auth.authMethod === "claude.ai" ? "probe" : "no_subscription";
}

// The CLI's own words for "this login can't make the turn", seen in
// journal/99 §1.5 ("Not logged in · Please run /login", "Invalid API key")
// plus the API's `authentication_error`/401 for an expired or revoked token.
const SIGNED_OUT_PATTERN = /not logged in|\/login|authentication_error|oauth token|token (has )?expired|\b401\b/i;
const API_KEY_PATTERN = /invalid api key|x-api-key/i;

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Reads the probe's stream-json output. The `rate_limit_event` is the
 * answer, whatever else the turn did — when the account is limited the turn
 * itself fails (`result.is_error`, "You've hit your session limit") and the
 * event still says `rejected`. Without an event, the `result` says why.
 */
export function interpretClaudeUsageProbe(output: ProcessOutput, auth: ClaudeUsageAuth, observedAt: number): ClaudeUsageProbeResult {
  let resultText: string | undefined;
  for (const line of output.stdout.split("\n")) {
    if (!line.trim()) continue;
    const event = parseLine(line);
    const reading = parseClaudeRateLimitEvent(event);
    if (reading) {
      // `claudeReadingStatus` only ever answers ok/warning/limited.
      const status = claudeReadingStatus(reading) as PlanUsageReading["status"];
      const usage: PlanUsageReading = { status, windows: reading.windows, observedAt, source: "probe" };
      const plan = claudePlanLabel({ subscriptionType: auth.subscriptionType, authMethod: auth.authMethod });
      if (plan) usage.plan = plan;
      return { kind: "reading", reading: usage, claudeStatus: reading.claudeStatus, auth };
    }
    if (isRecord(event) && event.type === "result" && event.is_error === true && typeof event.result === "string") {
      resultText = event.result;
    }
  }
  if (resultText !== undefined) {
    if (API_KEY_PATTERN.test(resultText)) return { kind: "auth", status: "no_subscription", probed: true, auth };
    if (SIGNED_OUT_PATTERN.test(resultText)) return { kind: "auth", status: "signed_out", probed: true, auth };
  }
  // A clean turn without the event is a CLI that stopped emitting it — a
  // parse problem, not the network's.
  return { kind: "error", error: output.exitCode === 0 ? "parse" : "unknown", probed: true };
}

/**
 * Pre-check, then probe. Never throws: every failure comes back as a result
 * the service folds into its state.
 */
export async function probeClaudeUsage(homeOverride: string | undefined, deps: ClaudeUsageProbeDeps = defaultClaudeUsageProbeDeps()): Promise<ClaudeUsageProbeResult> {
  let auth: ClaudeUsageAuth;
  try {
    auth = await deps.readAuthStatus(homeOverride);
  } catch {
    return { kind: "error", error: "unknown", probed: false };
  }
  const gate = claudeUsageAuthGate(auth);
  if (gate !== "probe") return { kind: "auth", status: gate, probed: false, auth };

  let output: ProcessOutput;
  try {
    output = await deps.runProbe(homeOverride, CLAUDE_USAGE_PROBE_ARGS);
  } catch (error) {
    return { kind: "error", error: error instanceof ProbeTimeoutError ? "network" : "unknown", probed: true };
  }
  return interpretClaudeUsageProbe(output, auth, deps.now());
}

export class ProbeTimeoutError extends Error {
  constructor() {
    super("claude usage probe timed out");
    this.name = "ProbeTimeoutError";
  }
}

export interface ClaudeUsageSpawnOptions {
  /** The CLI to spawn; defaults to the one every Claude turn uses. */
  bin?: string;
  /** Empty directory the probe runs in; created (0700) when missing. */
  cwd?: string;
  probeTimeoutMs?: number;
}

/** The probe's working directory: empty, the relay's own, never a project. */
export function defaultClaudeUsageProbeCwd(env: NodeJS.ProcessEnv = process.env): string {
  return join(sessionsRoot(env), "usage-probe");
}

function spawnCollect(bin: string, args: readonly string[], homeOverride: string | undefined, cwd: string | undefined, timeoutMs: number): Promise<ProcessOutput> {
  const binDir = bin.includes(sep) ? dirname(bin) : undefined;
  const pathDirs = binDir ? [...EXTRA_PATH_DIRS, binDir] : EXTRA_PATH_DIRS;
  const env = buildChildEnv(homeOverride, pathDirs, stripBilledCredentials, claudeRuntimeDef.identity.env.set);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new ProbeTimeoutError());
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ stdout, exitCode });
    });
  });
}

/** The real spawns: `claude auth status --json`, then the probe turn, both
 * under the profile's `$HOME` and without billed credentials. */
export function defaultClaudeUsageProbeDeps(options: ClaudeUsageSpawnOptions = {}): ClaudeUsageProbeDeps {
  const bin = resolveAgentBin(options.bin ?? claudeRuntimeDef.identity.bin);
  const cwd = options.cwd ?? defaultClaudeUsageProbeCwd();
  return {
    readAuthStatus: async (homeOverride) => {
      const output = await spawnCollect(bin, ["auth", "status", "--json"], homeOverride, undefined, AUTH_STATUS_TIMEOUT_MS);
      return parseClaudeUsageAuth(output.stdout);
    },
    runProbe: (homeOverride, args) => {
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      return spawnCollect(bin, args, homeOverride, cwd, options.probeTimeoutMs ?? CLAUDE_USAGE_PROBE_TIMEOUT_MS);
    },
    now: () => Date.now(),
  };
}
