// Pulls the Codex plan usage from a `codex app-server` of its own (D4,
// journal/99 §2.3): `account/read` first (who is logged in, on which plan),
// then `account/rateLimits/read`. Reading spends no quota and starts no turn;
// the app-server only asks the backend.
//
// The process is the same transport the Codex sessions use (`spawnCodexDaemon`,
// unchanged) and is kept alive between reads: a spawn and `initialize` cost
// 0.24–3 s, a read once it's up 0.6–0.9 s. Its idle reaper retires it if the
// owner stops reading; the owner calls `close()` when no client is connected.
// Pushes (`account/rateLimits/updated`) that arrive on it merge into the last
// read (by `limitId`, codexLimits.ts) and are reported to `onUpdate`.
//
// Before spawning anything, `$CODEX_HOME/auth.json` must exist (checked, never
// read: it is a credential). With no login there is nothing to read, and an
// app-server pointed at a CODEX_HOME the user doesn't use fills it with state
// (and took 30 s to initialize there).
//
// Only the account bucket (`codex`) becomes plan windows: per-model buckets
// stay out of the first cut (D15/D23).
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { codexRuntimeDef } from "../../runtimes/defs/codex.js";
import { spawnCodexDaemon, type CodexDaemon, type SpawnCodexDaemonOptions } from "../../runtimes/transports/codexDaemon.js";
import { JsonRpcRemoteError } from "../../runtimes/transports/jsonRpcStdio.js";
import type { AgentRuntimeDef, TurnHost } from "../../runtimes/types.js";
import {
  CODEX_ACCOUNT_LIMIT_ID,
  classifyCodexRateLimitsError,
  codexLimitsPlanType,
  codexLimitsStatus,
  codexPlanWindows,
  mergeCodexRateLimits,
  parseCodexAccount,
  parseCodexRateLimitsRead,
  parseCodexRateLimitsUpdated,
  type CodexLimitBucket,
  type CodexRateLimits,
} from "../codexLimits.js";
import type { PlanUsageReading } from "../ingest.js";
import { codexPlanLabel } from "../planLabel.js";
import type { PlanUsageErrorKind, PlanUsageSource, PlanUsageStatus } from "../types.js";
import { isRecord } from "../windows.js";

export const CODEX_INIT_TIMEOUT_MS = 30_000;
export const CODEX_REQUEST_TIMEOUT_MS = 10_000;

/** What `account/read` says about who is logged in — the parts of the
 * account key (journal/99 §12.3). Holds an e-mail: hand it to the account
 * key derivation and nowhere else; never serialize or log it. */
export interface CodexAccountIdentity {
  email: string | null;
  planType: string | null;
}

export type CodexRateLimitsResult =
  /** A read that went through: feed `reading` to `ingestReading`. */
  | { kind: "reading"; reading: PlanUsageReading; identity: CodexAccountIdentity | null }
  /** No login, or a login without a plan: `ingestAuthState`. */
  | { kind: "auth"; status: Extract<PlanUsageStatus, "signed_out" | "no_subscription"> }
  /** The read failed: `ingestError`. */
  | { kind: "error"; error: PlanUsageErrorKind };

/** The injectable seam: what the plan usage service calls to pull. */
export type ReadCodexRateLimits = () => Promise<CodexRateLimitsResult>;

export interface CodexRateLimitsReader {
  /** Reads now. Never rejects. Concurrent calls share one read. */
  read: ReadCodexRateLimits;
  /** Stops the app-server, if one is up. The next `read` spawns a new one. */
  close(): void;
}

export interface CodexRateLimitsReaderOptions {
  /** The profile's `$HOME` (`RELAY_HOME_OVERRIDE`); the relay's own when absent. */
  readonly homeOverride?: string;
  /** Where `CODEX_HOME` is looked up; `process.env` by default. */
  readonly env?: NodeJS.ProcessEnv;
  /** The Codex def; tests swap `identity.bin` for the fake app-server. */
  readonly def?: AgentRuntimeDef;
  /** The app-server's cwd. No thread runs there, so any directory works;
   * the system temp dir keeps it away from a repo's AGENTS.md. */
  readonly cwd?: string;
  /** A pushed update merged into the last read. Only pushes that touch the
   * account bucket are reported; the reading carries every window known. */
  readonly onUpdate?: (reading: PlanUsageReading) => void;
  readonly now?: () => number;
  readonly initTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** Defaults to `spawnCodexDaemon`. */
  readonly spawnDaemon?: (options: SpawnCodexDaemonOptions) => Promise<CodexDaemon>;
}

class CodexReadTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`codex rate limits: ${what} timed out after ${ms} ms`);
    this.name = "CodexReadTimeout";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CodexReadTimeout(what, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** The reader never answers a server request: it starts no turn, so none is
 * expected. Should one come anyway, it is declined. */
const DECLINING_HOST: TurnHost = {
  requestApproval: (request) => Promise.resolve(request.safeDecisionId ?? "decline"),
  requestUserInput: () => Promise.resolve("deferred" as const),
};

/** `$CODEX_HOME`, `~/.codex` by default, for the profile's home. */
export function codexHomeDir(homeOverride: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homeOverride ?? env.HOME ?? homedir(), ".codex");
}

function accountIdentity(result: unknown): CodexAccountIdentity | null {
  if (!isRecord(result) || !isRecord(result.account) || result.account.type !== "chatgpt") return null;
  const { email, planType } = result.account;
  return {
    email: typeof email === "string" && email.trim() !== "" ? email.trim() : null,
    planType: typeof planType === "string" && planType.trim() !== "" ? planType.trim().toLowerCase() : null,
  };
}

function toReading(limits: CodexRateLimits, planType: string | null, observedAt: number, source: PlanUsageSource): PlanUsageReading {
  const status = codexLimitsStatus(limits);
  const reading: PlanUsageReading = { status: status === "limited" ? "limited" : "ok", windows: codexPlanWindows(limits), observedAt, source };
  const plan = codexPlanLabel(planType ?? codexLimitsPlanType(limits));
  if (plan) reading.plan = plan;
  return reading;
}

export function createCodexRateLimitsReader(options: CodexRateLimitsReaderOptions = {}): CodexRateLimitsReader {
  const now = options.now ?? Date.now;
  const spawnDaemon = options.spawnDaemon ?? spawnCodexDaemon;
  const initTimeoutMs = options.initTimeoutMs ?? CODEX_INIT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS;

  let daemon: CodexDaemon | undefined;
  let starting: Promise<CodexDaemon> | undefined;
  let inFlight: Promise<CodexRateLimitsResult> | undefined;
  // What the last read and the pushes since then say; pushes merge into it.
  let limits: CodexRateLimits | undefined;
  let planType: string | null = null;
  // Bumped by `close()`: a spawn that resolves after it is killed at once.
  let generation = 0;
  // Pushes that arrive while `account/rateLimits/read` is in flight. The
  // reply and a push right behind it can come in the same chunk, and then
  // the push is handled before the awaiting read stores `limits`: held here
  // and folded in once it does, instead of dropped.
  let pendingPushes: CodexLimitBucket[] | undefined;

  function onNotification(method: string, params: unknown): void {
    if (method !== "account/rateLimits/updated") return;
    const bucket = parseCodexRateLimitsUpdated(params);
    if (!bucket || bucket.limitId !== CODEX_ACCOUNT_LIMIT_ID) return;
    if (pendingPushes) {
      pendingPushes.push(bucket);
      return;
    }
    if (!limits) return;
    applyPush(bucket);
  }

  function applyPush(bucket: CodexLimitBucket): void {
    if (!limits) return;
    const merged = mergeCodexRateLimits(limits, bucket);
    if (merged === limits) return;
    limits = merged;
    options.onUpdate?.(toReading(limits, planType, now(), "app_server_push"));
  }

  function ensureDaemon(): Promise<CodexDaemon> {
    if (daemon && !daemon.exited) return Promise.resolve(daemon);
    if (starting) return starting;
    const mine = generation;
    const spawned = spawnDaemon({
      def: options.def ?? codexRuntimeDef,
      cwd: options.cwd ?? tmpdir(),
      homeOverride: options.homeOverride,
      host: DECLINING_HOST,
      onNotification,
      onExit: () => {
        daemon = undefined;
      },
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    });
    // A handshake that answers after the timeout (or after `close()`) leaves
    // a process nobody holds: stop it as soon as it shows up. One that never
    // answers at all can't be stopped from here (`spawnCodexDaemon` hands
    // out no process before `initialize`); the auth.json check in `read` is
    // what keeps the reader off the CODEX_HOME where that was seen.
    let abandoned = false;
    void spawned.then(
      (started) => {
        if (abandoned || mine !== generation) started.kill();
      },
      () => {},
    );
    starting = withTimeout(spawned, initTimeoutMs, "initialize").then(
      (started) => {
        starting = undefined;
        if (mine !== generation) throw new Error("codex rate limits: reader closed while starting");
        daemon = started;
        return started;
      },
      (error: unknown) => {
        abandoned = true;
        starting = undefined;
        throw error;
      },
    );
    return starting;
  }

  function stop(): void {
    generation++;
    starting = undefined;
    daemon?.kill();
    daemon = undefined;
  }

  async function request(target: CodexDaemon, method: string, params: unknown): Promise<unknown> {
    try {
      return await withTimeout(target.request(method, params), requestTimeoutMs, method);
    } catch (error) {
      // A request that never answers means a wedged app-server: start over.
      if (error instanceof CodexReadTimeout && daemon === target) stop();
      throw error;
    }
  }

  async function readOnce(): Promise<CodexRateLimitsResult> {
    const result = await readAccount();
    // Pushes merge only into a read of the account that is logged in now.
    if (result.kind !== "reading") limits = undefined;
    return result;
  }

  async function readAccount(): Promise<CodexRateLimitsResult> {
    if (!existsSync(join(codexHomeDir(options.homeOverride, options.env), "auth.json"))) return { kind: "auth", status: "signed_out" };
    try {
      const target = await ensureDaemon();
      const accountResult = await request(target, "account/read", { refreshToken: false });
      const account = parseCodexAccount(accountResult);
      if (!account) {
        // A login type the reader doesn't know (e.g. `amazonBedrock`) has
        // no ChatGPT plan to read.
        if (isRecord(accountResult) && isRecord(accountResult.account)) return { kind: "auth", status: "no_subscription" };
        return { kind: "error", error: "parse" };
      }
      if (account.kind === "signed_out") return { kind: "auth", status: "signed_out" };
      if (account.kind === "api_key") return { kind: "auth", status: "no_subscription" };

      let rateLimitsResult: unknown;
      pendingPushes = [];
      try {
        rateLimitsResult = await request(target, "account/rateLimits/read", { excludeResetCreditDetails: true });
      } catch (error) {
        pendingPushes = undefined;
        const auth = error instanceof JsonRpcRemoteError ? classifyCodexRateLimitsError({ code: error.code, message: error.message }) : null;
        if (auth) return { kind: "auth", status: auth };
        throw error;
      }
      const held = pendingPushes;
      pendingPushes = undefined;
      const parsed = parseCodexRateLimitsRead(rateLimitsResult);
      if (!parsed) return { kind: "error", error: "parse" };
      limits = parsed;
      planType = account.planType;
      // Reported after the read itself, so the owner ingests them in order.
      if (held.length > 0) setImmediate(() => held.forEach(applyPush));
      return { kind: "reading", reading: toReading(parsed, planType, now(), "app_server_read"), identity: accountIdentity(accountResult) };
    } catch (error) {
      if (error instanceof CodexReadTimeout) return { kind: "error", error: "network" };
      return { kind: "error", error: "unknown" };
    }
  }

  return {
    read() {
      inFlight ??= readOnce().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    close: stop,
  };
}
