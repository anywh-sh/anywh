// The plan usage service: one per relay process, so one per profile. It
// keeps the state of every installed runtime, folds in what the agent
// streams report (capture.ts), reads on its own when scheduler.ts says so,
// reads on demand (the refresh button), persists the last state so a restart
// doesn't fall back to "no data", and tells subscribers when anything
// changes.
//
// The WebSocket (`/plan-usage/watch`) and `GET /plan-usage` sit on top of
// `subscribe`/`getSnapshot`/`connectClient`/`refresh`; nothing here knows
// about sockets.
//
// Identity: `claude auth status` (email, orgId), `.claude.json` (UUIDs) and
// Codex `account/read` (email) are hashed into `accountKey` here and dropped
// — they never reach the state, the snapshot file, a subscriber or a log.
import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { claudeAccountKey, deriveAccountKey, loadOrCreateAccountSalt } from "./accountKey.js";
import type { PlanUsageCapture, PlanUsageCaptureEvent } from "./capture.js";
import { createClaudeAccountFileReader, type ClaudeAccountFile } from "./claudeTier.js";
import { CODEX_ACCOUNT_LIMIT_ID } from "./codexLimits.js";
import { emptyPlanUsage, ingestAuthState, ingestError, ingestReading, presentPlanUsage, type PlanUsageReading } from "./ingest.js";
import { claudePlanLabel } from "./planLabel.js";
import {
  claudeUsageAuthGate,
  defaultClaudeUsageProbeDeps,
  probeClaudeUsage,
  type ClaudeUsageAuth,
  type ClaudeUsageProbeResult,
} from "./probes/claudeUsageProbe.js";
import { createCodexRateLimitsReader, type CodexRateLimitsReader, type CodexRateLimitsResult } from "./probes/codexRateLimits.js";
import {
  CLAUDE_PROBE_INTERVAL_MS,
  CONNECT_FLOOR_MS,
  SCHEDULER_TICK_MS,
  activityThreshold,
  backoffDelay,
  claudeWindowActive,
  decideClaudeAuto,
  decideCodexAuto,
  nextClaudeAutoRefreshAt,
  nextCodexAutoRefreshAt,
  type ClaudeAutoContext,
} from "./scheduler.js";
import { hasClaudeActivitySince } from "./transcriptActivity.js";
import { readClaudeTranscriptLimit, type TranscriptLimit } from "./transcriptLimits.js";
import type { PlanUsageRuntime, PlanUsageStateMessage, RuntimePlanUsage } from "./types.js";
import { isRecord } from "./windows.js";

/** Set to `0` to stop every Claude probe, automatic or forced (a probe is a
 * real, if minimal, turn). Turns' own readings and Codex reads go on. */
export const PLAN_USAGE_PROBE_ENV = "ANYWH_PLAN_USAGE_PROBE";

export function isPlanUsageProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PLAN_USAGE_PROBE_ENV] !== "0";
}

export interface PlanUsageSnapshotStore {
  load(): RuntimePlanUsage[] | undefined;
  save(runtimes: RuntimePlanUsage[]): void;
}

export interface PlanUsageServiceDeps {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  capture: Pick<PlanUsageCapture, "subscribe" | "isTurnActive">;
  probeEnabled: boolean;
  /** One Claude probe (auth pre-check included). */
  probeClaude: () => Promise<ClaudeUsageProbeResult>;
  /** `claude auth status`, no turn. Rejects when it couldn't be read. */
  readClaudeAuth: () => Promise<ClaudeUsageAuth>;
  readClaudeAccountFile: () => Promise<ClaudeAccountFile | undefined>;
  hasClaudeActivitySince: (since: number) => Promise<boolean>;
  /** The latest limit refusal in the profile's Claude transcripts, if its
   * window is still running at `now`. */
  readClaudeTranscriptLimit: (now: number) => Promise<TranscriptLimit | undefined>;
  createCodexReader: (onUpdate: (reading: PlanUsageReading) => void) => CodexRateLimitsReader;
  /** The machine's account salt; undefined turns account keys off. */
  loadSalt: () => Promise<Uint8Array | undefined>;
  store?: PlanUsageSnapshotStore;
  log?: (line: string) => void;
}

export type PlanUsageListener = (message: PlanUsageStateMessage) => void;

export interface PlanUsageRefreshOptions {
  /** Absent = every installed runtime. */
  runtime?: PlanUsageRuntime;
  /** The refresh button: Claude probes even with the window expired (D13);
   * without it Claude answers from the cache and Codex is re-read. */
  force: boolean;
}

interface RuntimeSlot {
  usage: RuntimePlanUsage;
  /** The lock: the read (probe or pull) in flight, if any. */
  inFlight?: Promise<void>;
  /** When the read in flight started; cleared just before its result is
   * applied, so the state pushed with the result already says it ended. */
  readingSince?: number;
  failures: number;
  backoffUntil: number | null;
}

const RUNTIMES: readonly PlanUsageRuntime[] = ["claude", "codex"];

export class PlanUsageService {
  private readonly slots: Record<PlanUsageRuntime, RuntimeSlot>;
  private installed = new Set<PlanUsageRuntime>();
  private readonly listeners = new Set<PlanUsageListener>();
  private clients = 0;
  private timer: unknown;
  private unsubscribeCapture?: () => void;
  private codexReader?: CodexRateLimitsReader;
  private claudeAuthInFlight?: Promise<void>;
  private lastClaudeAuthCheckAt: number | null = null;
  private lastTranscriptLimitCheckAt: number | null = null;
  private salt?: Promise<Uint8Array | undefined>;

  constructor(private readonly deps: PlanUsageServiceDeps) {
    const stored = new Map((deps.store?.load() ?? []).map((usage) => [usage.runtime, usage]));
    this.slots = {
      claude: { usage: stored.get("claude") ?? emptyPlanUsage("claude"), failures: 0, backoffUntil: null },
      codex: { usage: stored.get("codex") ?? emptyPlanUsage("codex"), failures: 0, backoffUntil: null },
    };
  }

  /** Starts listening to the agent streams. */
  start(): void {
    this.unsubscribeCapture ??= this.deps.capture.subscribe((event) => this.onCapture(event));
  }

  stop(): void {
    this.unsubscribeCapture?.();
    this.unsubscribeCapture = undefined;
    this.stopTimer();
    this.codexReader?.close();
  }

  /** The runtimes installed on this relay (`selectableAgents`); only these
   * are read and reported. */
  setInstalledRuntimes(runtimes: readonly string[]): void {
    const next = new Set(RUNTIMES.filter((runtime) => runtimes.includes(runtime)));
    const changed = next.size !== this.installed.size || [...next].some((runtime) => !this.installed.has(runtime));
    this.installed = next;
    if (!next.has("codex")) this.codexReader?.close();
    if (!changed) return;
    this.notify();
    if (this.clients > 0) void this.evaluate(true);
  }

  /** The state as it may be shown now: installed runtimes only, expired
   * windows at 0 %, next automatic read filled in. */
  getSnapshot(): PlanUsageStateMessage {
    const now = this.deps.now();
    const runtimes = RUNTIMES.filter((runtime) => this.installed.has(runtime)).map((runtime) => {
      const slot = this.slots[runtime];
      const shown = { ...presentPlanUsage(slot.usage, now) };
      if (slot.readingSince !== undefined) {
        shown.reading = true;
        shown.readingSince = slot.readingSince;
      }
      const base = { now, clients: this.clients, lastReadingAt: slot.usage.observedAt, backoffUntil: slot.backoffUntil };
      shown.nextAutoRefreshAt =
        runtime === "claude"
          ? nextClaudeAutoRefreshAt({ ...base, probeEnabled: this.deps.probeEnabled, usage: slot.usage })
          : nextCodexAutoRefreshAt(base);
      return shown;
    });
    return { type: "plan_usage_state", runtimes, observedAt: now };
  }

  /** Called with the snapshot on every change. */
  subscribe(listener: PlanUsageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A client started watching. Automatic reads run only while at least one
   * is; the returned function releases it (safe to call twice). */
  connectClient(): () => void {
    this.clients += 1;
    if (this.clients === 1) this.timer = this.deps.setInterval(() => void this.evaluate(false), SCHEDULER_TICK_MS);
    void this.evaluate(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.clients -= 1;
      if (this.clients === 0) {
        this.stopTimer();
        this.codexReader?.close();
      }
    };
  }

  get connectedClients(): number {
    return this.clients;
  }

  /** On-demand read. Resolves when the reads it started (or joined) end. */
  async refresh(options: PlanUsageRefreshOptions): Promise<void> {
    const targets = RUNTIMES.filter((runtime) => this.installed.has(runtime) && (!options.runtime || options.runtime === runtime));
    await Promise.all(
      targets.map((runtime) => {
        if (runtime === "codex") return this.readCodex();
        return options.force ? this.forcedClaude() : Promise.resolve();
      }),
    );
  }

  // --- automatic reads -------------------------------------------------

  private async evaluate(onConnect: boolean): Promise<void> {
    if (this.clients <= 0) return;
    const now = this.deps.now();
    const work: Promise<void>[] = [];

    if (this.installed.has("codex")) {
      const slot = this.slots.codex;
      const decision = decideCodexAuto({
        now,
        clients: this.clients,
        inFlight: slot.inFlight !== undefined,
        turnActive: this.deps.capture.isTurnActive("codex"),
        lastReadingAt: slot.usage.observedAt,
        backoffUntil: slot.backoffUntil,
        onConnect,
      });
      if (decision === "read") work.push(this.readCodex());
    }

    if (this.installed.has("claude")) work.push(this.evaluateClaude(now, onConnect));
    await Promise.all(work);
  }

  private async evaluateClaude(now: number, onConnect: boolean): Promise<void> {
    const slot = this.slots.claude;
    const status = slot.usage.status;
    const authDue =
      this.lastClaudeAuthCheckAt === null || now - this.lastClaudeAuthCheckAt >= (onConnect ? CONNECT_FLOOR_MS : CLAUDE_PROBE_INTERVAL_MS);
    if ((status === "unknown" || status === "signed_out" || status === "no_subscription") && authDue) {
      await this.checkClaudeAuth();
    }

    if (!claudeWindowActive(slot.usage, now) && slot.usage.status !== "signed_out" && slot.usage.status !== "no_subscription") {
      await this.checkClaudeTranscriptLimit(now, onConnect);
    }

    const ctx = (localActivity: boolean): ClaudeAutoContext => ({
      now,
      clients: this.clients,
      inFlight: slot.inFlight !== undefined,
      turnActive: this.deps.capture.isTurnActive("claude"),
      lastReadingAt: slot.usage.observedAt,
      backoffUntil: slot.backoffUntil,
      onConnect,
      probeEnabled: this.deps.probeEnabled,
      usage: slot.usage,
      localActivity,
    });
    let decision = decideClaudeAuto(ctx(false));
    if (decision === "skip" && decideClaudeAuto(ctx(true)) === "probe" && !claudeWindowActive(slot.usage, now)) {
      const since = activityThreshold(slot.usage, now);
      const active = since !== null && (await this.deps.hasClaudeActivitySince(since).catch(() => false));
      // Re-decided after the await: a turn or another read may have started.
      decision = active ? decideClaudeAuto({ ...ctx(true), now: this.deps.now() }) : "skip";
    }
    if (decision === "probe") await this.probeClaude();
  }

  // --- Claude ------------------------------------------------------------

  /** With no active 5h window known, a limit refusal Claude Code wrote into
   * a transcript (outside anywh) still says "limited until X" — read without
   * probing, at most once a minute. */
  private async checkClaudeTranscriptLimit(now: number, onConnect: boolean): Promise<void> {
    const last = this.lastTranscriptLimitCheckAt;
    if (last !== null && now - last < (onConnect ? 0 : SCHEDULER_TICK_MS)) return;
    this.lastTranscriptLimitCheckAt = now;
    const limit = await this.deps.readClaudeTranscriptLimit(now).catch(() => undefined);
    if (!limit) return;
    const slot = this.slots.claude;
    this.update("claude", ingestReading(slot.usage, { status: "limited", windows: [limit.window], observedAt: limit.observedAt, source: "transcript" }));
  }

  private async forcedClaude(): Promise<void> {
    if (!this.deps.probeEnabled) return this.checkClaudeAuth();
    // A login without a plan would only be billed: re-check the login, and
    // probe only if it now is a subscription.
    if (this.slots.claude.usage.status === "no_subscription") {
      await this.checkClaudeAuth();
      if (this.slots.claude.usage.status === "no_subscription" || this.slots.claude.usage.status === "signed_out") return;
    }
    return this.probeClaude();
  }

  private probeClaude(): Promise<void> {
    return this.read("claude", async () => {
      const result = await this.deps.probeClaude().catch((): ClaudeUsageProbeResult => ({ kind: "error", error: "unknown", probed: false }));
      return () => this.applyClaudeResult(result);
    });
  }

  /**
   * Runs one read of `runtime` under its lock (a read already in flight is
   * joined), and tells subscribers when it starts and when it ends: `fetch`
   * does the slow part and returns how to apply its result, which runs once
   * `reading` is cleared, so the state it pushes already says the read is
   * over. A result that changes nothing still gets its "ended" push.
   */
  private read(runtime: PlanUsageRuntime, fetch: () => Promise<() => Promise<void>>): Promise<void> {
    const slot = this.slots[runtime];
    slot.inFlight ??= (async () => {
      slot.readingSince = this.deps.now();
      if (this.installed.has(runtime)) this.notify();
      let apply: (() => Promise<void>) | undefined;
      try {
        apply = await fetch();
      } finally {
        slot.readingSince = undefined;
      }
      const before = slot.usage;
      await apply();
      if (slot.usage === before && this.installed.has(runtime)) this.notify();
    })().finally(() => {
      slot.readingSince = undefined;
      slot.inFlight = undefined;
    });
    return slot.inFlight;
  }

  private async applyClaudeResult(result: ClaudeUsageProbeResult): Promise<void> {
    const slot = this.slots.claude;
    switch (result.kind) {
      case "reading": {
        const identity = await this.claudeIdentity(result.auth);
        const reading = identity.plan ? { ...result.reading, plan: identity.plan } : result.reading;
        this.succeed("claude", withAccountKey(ingestReading(slot.usage, reading), identity.accountKey));
        return;
      }
      case "auth":
        this.succeed("claude", ingestAuthState(slot.usage, result.status, this.deps.now()));
        return;
      case "error":
        this.fail("claude", result.error);
        return;
    }
  }

  /** `claude auth status` without a turn: tells a login or logout apart
   * and fills the plan and account key. */
  private checkClaudeAuth(): Promise<void> {
    this.claudeAuthInFlight ??= (async () => {
      this.lastClaudeAuthCheckAt = this.deps.now();
      let auth: ClaudeUsageAuth;
      try {
        auth = await this.deps.readClaudeAuth();
      } catch {
        return;
      }
      const slot = this.slots.claude;
      const gate = claudeUsageAuthGate(auth);
      if (gate !== "probe") {
        if (slot.usage.status !== gate) this.update("claude", ingestAuthState(slot.usage, gate, this.deps.now()));
        return;
      }
      const identity = await this.claudeIdentity(auth);
      // Just logged in: nothing read for this account yet.
      const base =
        slot.usage.status === "signed_out" || slot.usage.status === "no_subscription" ? emptyPlanUsage("claude") : { ...slot.usage };
      if (identity.plan) base.plan = identity.plan;
      else delete base.plan;
      this.update("claude", withAccountKey(base, identity.accountKey));
    })().finally(() => {
      this.claudeAuthInFlight = undefined;
    });
    return this.claudeAuthInFlight;
  }

  private async claudeIdentity(auth: ClaudeUsageAuth): Promise<{ plan?: RuntimePlanUsage["plan"]; accountKey?: string }> {
    const file = await this.deps.readClaudeAccountFile().catch(() => undefined);
    const plan = claudePlanLabel({
      subscriptionType: auth.subscriptionType,
      authMethod: auth.authMethod,
      userRateLimitTier: file?.tiers.userRateLimitTier,
      organizationRateLimitTier: file?.tiers.organizationRateLimitTier,
    });
    const salt = await this.getSalt();
    const accountKey = salt ? claudeAccountKey(salt, file?.identity, auth) : undefined;
    return { ...(plan ? { plan } : {}), ...(accountKey ? { accountKey } : {}) };
  }

  // --- Codex -------------------------------------------------------------

  private reader(): CodexRateLimitsReader {
    this.codexReader ??= this.deps.createCodexReader((reading) => this.update("codex", ingestReading(this.slots.codex.usage, reading)));
    return this.codexReader;
  }

  private readCodex(): Promise<void> {
    return this.read("codex", async () => {
      const result = await this.reader()
        .read()
        .catch((): CodexRateLimitsResult => ({ kind: "error", error: "unknown" }));
      return () => this.applyCodexResult(result);
    });
  }

  private async applyCodexResult(result: CodexRateLimitsResult): Promise<void> {
    const slot = this.slots.codex;
    switch (result.kind) {
      case "reading": {
        const salt = result.identity ? await this.getSalt() : undefined;
        const accountKey = salt && result.identity ? deriveAccountKey(salt, "codex", "codex_email_plan", result.identity.email, result.identity.planType) : undefined;
        this.succeed("codex", withAccountKey(ingestReading(slot.usage, result.reading), accountKey));
        return;
      }
      case "auth":
        this.succeed("codex", ingestAuthState(slot.usage, result.status, this.deps.now()));
        return;
      case "error":
        this.fail("codex", result.error);
        return;
    }
  }

  // --- streams -----------------------------------------------------------

  private onCapture(event: PlanUsageCaptureEvent): void {
    switch (event.kind) {
      case "reading":
        this.update("claude", ingestReading(this.slots.claude.usage, event.reading));
        return;
      case "codex_push": {
        const { bucket } = event;
        if (bucket.limitId !== CODEX_ACCOUNT_LIMIT_ID || bucket.windows.length === 0) return;
        const previous = this.slots.codex.usage;
        // A push says nothing about `ordinaryUsageAllowed`: a limited
        // account stays limited until the next read says otherwise.
        const status = bucket.rateLimitReachedType || previous.status === "limited" ? "limited" : "ok";
        this.update("codex", ingestReading(previous, { status, windows: bucket.windows, observedAt: event.observedAt, source: "app_server_push" }));
        return;
      }
      case "turn_activity":
        // A finished Codex turn may have moved the limits: pull, if anyone
        // is watching.
        if (event.runtime === "codex" && !event.active && this.clients > 0 && this.installed.has("codex")) void this.readCodex();
        return;
    }
  }

  // --- state -------------------------------------------------------------

  private succeed(runtime: PlanUsageRuntime, next: RuntimePlanUsage): void {
    const slot = this.slots[runtime];
    slot.failures = 0;
    slot.backoffUntil = null;
    this.update(runtime, next);
  }

  private fail(runtime: PlanUsageRuntime, kind: NonNullable<RuntimePlanUsage["error"]>["kind"]): void {
    const slot = this.slots[runtime];
    slot.failures += 1;
    slot.backoffUntil = this.deps.now() + backoffDelay(slot.failures);
    this.deps.log?.(`[plan-usage] ${runtime} read failed (${kind}), attempt ${slot.failures}`);
    this.update(runtime, ingestError(slot.usage, kind));
  }

  private update(runtime: PlanUsageRuntime, next: RuntimePlanUsage): void {
    if (next === this.slots[runtime].usage) return;
    this.slots[runtime].usage = next;
    try {
      this.deps.store?.save(RUNTIMES.map((id) => this.slots[id].usage));
    } catch (error) {
      this.deps.log?.(`[plan-usage] snapshot not saved: ${(error as Error).message}`);
    }
    if (this.installed.has(runtime)) this.notify();
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const message = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // A subscriber's failure is its own.
      }
    }
  }

  private getSalt(): Promise<Uint8Array | undefined> {
    this.salt ??= this.deps.loadSalt().catch((error: unknown) => {
      this.deps.log?.(`[plan-usage] account salt unavailable, account keys off: ${(error as Error).message}`);
      return undefined;
    });
    return this.salt;
  }

  private stopTimer(): void {
    if (this.timer !== undefined) this.deps.clearInterval(this.timer);
    this.timer = undefined;
  }
}

function withAccountKey(usage: RuntimePlanUsage, accountKey: string | undefined): RuntimePlanUsage {
  const next = { ...usage };
  if (accountKey) next.accountKey = accountKey;
  else delete next.accountKey;
  return next;
}

// --- persistence -----------------------------------------------------------

/** Next to the profile's sessions file, like the room files. */
export function planUsagePathFor(sessionsFile: string): string {
  return sessionsFile.endsWith(".json") ? `${sessionsFile.slice(0, -".json".length)}-plan-usage.json` : `${sessionsFile}-plan-usage.json`;
}

const PERSISTED_KEYS = ["runtime", "status", "windows", "plan", "accountKey", "observedAt", "source", "error"] as const;

/** A stored entry, re-checked field by field: the file is ours, but a hand
 * edit or an older format must not reach the client unchecked. */
function restoreUsage(raw: unknown): RuntimePlanUsage | undefined {
  if (!isRecord(raw) || (raw.runtime !== "claude" && raw.runtime !== "codex")) return undefined;
  if (typeof raw.status !== "string" || !Array.isArray(raw.windows)) return undefined;
  if (raw.observedAt !== null && typeof raw.observedAt !== "number") return undefined;
  const windows = raw.windows.filter(
    (window): window is RuntimePlanUsage["windows"][number] =>
      isRecord(window) &&
      typeof window.durationMins === "number" &&
      typeof window.usedPercent === "number" &&
      (window.resetsAt === null || typeof window.resetsAt === "number") &&
      (window.limitId === undefined || typeof window.limitId === "string"),
  );
  const usage: Record<string, unknown> = {};
  for (const key of PERSISTED_KEYS) if (raw[key] !== undefined) usage[key] = raw[key];
  usage.windows = windows;
  // An error belongs to the process that saw it.
  if (usage.status === "error") usage.status = windows.length > 0 ? "ok" : "unknown";
  delete usage.error;
  return usage as unknown as RuntimePlanUsage;
}

export function createFilePlanUsageStore(path: string): PlanUsageSnapshotStore {
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!isRecord(parsed) || !Array.isArray(parsed.runtimes)) return undefined;
        return parsed.runtimes.map(restoreUsage).filter((usage): usage is RuntimePlanUsage => usage !== undefined);
      } catch {
        return undefined;
      }
    },
    save(runtimes) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const stored = runtimes.map((usage) => {
        const entry: Record<string, unknown> = {};
        for (const key of PERSISTED_KEYS) if (usage[key] !== undefined) entry[key] = usage[key];
        return entry;
      });
      writeFileSync(tmp, JSON.stringify({ version: 1, runtimes: stored }), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

// --- wiring ------------------------------------------------------------------

export interface CreatePlanUsageServiceOptions {
  capture: PlanUsageCapture;
  /** The profile's `$HOME` (`RELAY_HOME_OVERRIDE`); the relay's own when absent. */
  homeOverride?: string;
  /** The relay's sessions file; the snapshot is stored beside it. */
  sessionsFile: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** The service with its real dependencies; call `start()` to listen. */
export function createPlanUsageService(options: CreatePlanUsageServiceOptions): PlanUsageService {
  const env = options.env ?? process.env;
  const home = options.homeOverride ?? homedir();
  const probeDeps = defaultClaudeUsageProbeDeps();
  const readAccountFile = createClaudeAccountFileReader();
  return new PlanUsageService({
    now: Date.now,
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    capture: options.capture,
    probeEnabled: isPlanUsageProbeEnabled(env),
    probeClaude: () => probeClaudeUsage(options.homeOverride, probeDeps),
    readClaudeAuth: () => probeDeps.readAuthStatus(options.homeOverride),
    readClaudeAccountFile: () => readAccountFile(home, { env }),
    hasClaudeActivitySince: (since) => hasClaudeActivitySince(home, since, env),
    readClaudeTranscriptLimit: (now) => readClaudeTranscriptLimit(home, now, { env }),
    createCodexReader: (onUpdate) => createCodexRateLimitsReader({ homeOverride: options.homeOverride, env, onUpdate }),
    loadSalt: () => loadOrCreateAccountSalt(),
    store: createFilePlanUsageStore(planUsagePathFor(options.sessionsFile)),
    ...(options.log ? { log: options.log } : {}),
  });
}
