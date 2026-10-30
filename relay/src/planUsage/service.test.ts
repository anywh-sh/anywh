// The plan usage service against injected dependencies: a fake clock and
// interval, scripted probe/auth/Codex answers. Pure — no process, no file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanUsageCapture } from "./capture.js";
import type { PlanUsageReading } from "./ingest.js";
import type { ClaudeUsageAuth, ClaudeUsageProbeResult } from "./probes/claudeUsageProbe.js";
import type { CodexRateLimitsResult } from "./probes/codexRateLimits.js";
import { CLAUDE_PROBE_INTERVAL_MS, SCHEDULER_TICK_MS } from "./scheduler.js";
import { PlanUsageService, type PlanUsageServiceDeps, type PlanUsageSnapshotStore } from "./service.js";
import type { TranscriptLimit } from "./transcriptLimits.js";
import type { PlanUsageStateMessage, PlanWindow, RuntimePlanUsage } from "./types.js";

const NOW = 1_793_320_000_000;
const MIN = 60_000;
const EMAIL = "someone@example.invalid";
const ORG = "9b1d2e33-0000-4000-8000-00000000bbbb";
const ACCOUNT = "4f7c0a52-0000-4000-8000-00000000aaaa";
const AUTH: ClaudeUsageAuth = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: EMAIL, orgId: ORG };

function claudeWindows(fiveHour: number, resetsAt: number): PlanWindow[] {
  return [
    { durationMins: 300, usedPercent: fiveHour, resetsAt },
    { durationMins: 10080, usedPercent: 20, resetsAt: NOW + 3 * 24 * 60 * MIN },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
};

function harness(options: { probeEnabled?: boolean; installed?: string[]; store?: PlanUsageSnapshotStore } = {}) {
  let now = NOW;
  const intervals = new Map<number, () => void>();
  let nextId = 1;
  const capture = new PlanUsageCapture(() => now);
  const calls = { probe: 0, auth: 0, codexRead: 0, codexClose: 0, activity: 0, transcript: 0 };
  const h = {
    get now() {
      return now;
    },
    probe: (): Promise<ClaudeUsageProbeResult> =>
      Promise.resolve({ kind: "reading", reading: { status: "ok", windows: claudeWindows(40, now + 2 * 60 * MIN), observedAt: now, source: "probe" }, claudeStatus: "allowed", auth: AUTH }),
    auth: (): Promise<ClaudeUsageAuth> => Promise.resolve(AUTH),
    activity: false,
    transcriptLimit: undefined as TranscriptLimit | undefined,
    codex: (): Promise<CodexRateLimitsResult> =>
      Promise.resolve({
        kind: "reading",
        reading: { status: "ok", windows: [{ durationMins: 300, usedPercent: 10, resetsAt: now + 60 * MIN, limitId: "codex" }, { durationMins: 10080, usedPercent: 30, resetsAt: now + 3 * 24 * 60 * MIN, limitId: "codex" }], observedAt: now, source: "app_server_read", plan: { family: "plus", label: "Plus" } },
        identity: { email: EMAIL, planType: "plus" },
      }),
    codexUpdate: undefined as ((reading: PlanUsageReading) => void) | undefined,
    logs: [] as string[],
  };
  const deps: PlanUsageServiceDeps = {
    now: () => now,
    setInterval: (fn) => {
      const id = nextId++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id) => intervals.delete(id as number),
    capture,
    probeEnabled: options.probeEnabled ?? true,
    probeClaude: () => {
      calls.probe++;
      return h.probe();
    },
    readClaudeAuth: () => {
      calls.auth++;
      return h.auth();
    },
    readClaudeAccountFile: () =>
      Promise.resolve({
        tiers: { userRateLimitTier: null, organizationRateLimitTier: "default_claude_max_5x", seatTier: null, organizationType: "claude_max" },
        identity: { accountUuid: ACCOUNT, organizationUuid: ORG },
      }),
    hasClaudeActivitySince: () => {
      calls.activity++;
      return Promise.resolve(h.activity);
    },
    readClaudeTranscriptLimit: (at) => {
      calls.transcript++;
      const limit = h.transcriptLimit;
      return Promise.resolve(limit && limit.window.resetsAt !== null && limit.window.resetsAt > at ? limit : undefined);
    },
    createCodexReader: (onUpdate) => {
      h.codexUpdate = onUpdate;
      return {
        read: () => {
          calls.codexRead++;
          return h.codex();
        },
        close: () => calls.codexClose++,
      };
    },
    loadSalt: () => Promise.resolve(new Uint8Array(32).fill(3)),
    log: (line) => h.logs.push(line),
    ...(options.store ? { store: options.store } : {}),
  };
  const service = new PlanUsageService(deps);
  service.setInstalledRuntimes(options.installed ?? ["claude"]);
  service.start();
  const messages: PlanUsageStateMessage[] = [];
  service.subscribe((message) => messages.push(message));
  return {
    h,
    service,
    capture,
    calls,
    messages,
    intervals,
    claude: () => service.getSnapshot().runtimes.find((usage) => usage.runtime === "claude"),
    codex: () => service.getSnapshot().runtimes.find((usage) => usage.runtime === "codex"),
    /** Advances the clock by `ms`, firing the interval once per elapsed tick. */
    async advance(ms: number) {
      const end = now + ms;
      while (now + SCHEDULER_TICK_MS <= end) {
        now += SCHEDULER_TICK_MS;
        for (const fn of [...intervals.values()]) fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

test("unknown state: a connection reads the login (plan, account key) but never probes", async () => {
  const t = harness();
  t.service.connectClient();
  await settle();
  await t.advance(30 * MIN);
  assert.equal(t.calls.probe, 0);
  assert.ok(t.calls.auth >= 1);
  const usage = t.claude()!;
  assert.equal(usage.status, "unknown");
  assert.equal(usage.plan?.label, "Max 5x");
  assert.match(usage.accountKey ?? "", /^[0-9a-f]{16}$/);
  assert.equal(usage.nextAutoRefreshAt, null);
});

test("the refresh button always probes, then the 4-min cadence runs while the window is active", async () => {
  const t = harness();
  t.service.connectClient();
  await settle();
  await t.service.refresh({ force: true });
  assert.equal(t.calls.probe, 1);
  assert.equal(t.claude()?.windows[0]?.usedPercent, 40);
  await t.advance(CLAUDE_PROBE_INTERVAL_MS - MIN);
  assert.equal(t.calls.probe, 1);
  await t.advance(MIN);
  assert.equal(t.calls.probe, 2);
  // A refresh without force is the card opening: Claude answers from the cache.
  await t.service.refresh({ force: false });
  assert.equal(t.calls.probe, 2);
});

// Invariant: an expired window is never probed on its own, and never shown
// with its old percentage.
test("expired window: no automatic probe, shown at 0 %; the button still probes", async () => {
  const t = harness();
  const reset = NOW + 10 * MIN;
  t.h.probe = () =>
    Promise.resolve({ kind: "reading", reading: { status: "ok", windows: claudeWindows(80, reset), observedAt: t.h.now, source: "probe" }, claudeStatus: "allowed", auth: AUTH });
  t.service.connectClient();
  await t.service.refresh({ force: true });
  assert.equal(t.calls.probe, 1);
  await t.advance(60 * MIN);
  // Probes at +0 (button), +4, +8; the window ends at +10 and the margin
  // already stops the cadence at +9.
  assert.equal(t.calls.probe, 3);
  assert.equal(t.claude()?.windows[0]?.usedPercent, 0);
  assert.equal(t.claude()?.nextAutoRefreshAt, null);
  await t.advance(5 * 60 * MIN);
  assert.equal(t.calls.probe, 3);
  await t.service.refresh({ force: true });
  assert.equal(t.calls.probe, 4);
});

test("expired window with new local activity: one probe, since a window is already open", async () => {
  const t = harness();
  t.h.probe = () =>
    Promise.resolve({ kind: "reading", reading: { status: "ok", windows: claudeWindows(50, t.h.now + 2 * MIN), observedAt: t.h.now, source: "probe" }, claudeStatus: "allowed", auth: AUTH });
  t.service.connectClient();
  await t.service.refresh({ force: true });
  await t.advance(10 * MIN);
  assert.equal(t.calls.probe, 1);
  assert.ok(t.calls.activity > 0);
  t.h.activity = true;
  t.h.probe = () =>
    Promise.resolve({ kind: "reading", reading: { status: "ok", windows: claudeWindows(3, t.h.now + 4 * 60 * MIN), observedAt: t.h.now, source: "probe" }, claudeStatus: "allowed", auth: AUTH });
  await t.advance(MIN);
  assert.equal(t.calls.probe, 2);
  assert.equal(t.claude()?.windows[0]?.usedPercent, 3);
});

test("never read (D): local activity doesn't probe; only the button does", async () => {
  const t = harness();
  t.h.activity = true;
  t.service.connectClient();
  await t.advance(30 * MIN);
  assert.equal(t.calls.probe, 0);
  assert.equal(t.calls.activity, 0);
  assert.equal(t.claude()?.status, "unknown");
  assert.equal(t.claude()?.windows.length, 0);
  await t.service.refresh({ force: true });
  assert.equal(t.calls.probe, 1);
});

test("no client: nothing is read automatically, and the last release stops the timer", async () => {
  const t = harness({ installed: ["claude", "codex"] });
  await t.service.refresh({ force: true });
  const probes = t.calls.probe;
  const reads = t.calls.codexRead;
  await t.advance(30 * MIN);
  assert.equal(t.calls.probe, probes);
  assert.equal(t.calls.codexRead, reads);
  assert.equal(t.intervals.size, 0);

  const release = t.service.connectClient();
  const other = t.service.connectClient();
  assert.equal(t.intervals.size, 1);
  release();
  release();
  assert.equal(t.service.connectedClients, 1);
  other();
  assert.equal(t.intervals.size, 0);
  assert.equal(t.calls.codexClose, 1);
  const after = t.calls.probe;
  await t.advance(30 * MIN);
  assert.equal(t.calls.probe, after);
});

test("rejected: no automatic probe until the reset, nor after it", async () => {
  const t = harness();
  t.h.probe = () =>
    Promise.resolve({
      kind: "reading",
      reading: { status: "limited", windows: claudeWindows(100, t.h.now + 30 * MIN), observedAt: t.h.now, source: "probe" },
      claudeStatus: "rejected",
      auth: AUTH,
    });
  t.service.connectClient();
  await t.service.refresh({ force: true });
  assert.equal(t.claude()?.status, "limited");
  await t.advance(3 * 60 * MIN);
  assert.equal(t.calls.probe, 1);
  assert.equal(t.claude()?.status, "ok");
  assert.equal(t.claude()?.windows[0]?.usedPercent, 0);
});

test("the lock: concurrent refreshes and ticks share one probe", async () => {
  const t = harness();
  const pending = deferred<ClaudeUsageProbeResult>();
  t.h.probe = () => pending.promise;
  t.service.connectClient();
  const a = t.service.refresh({ force: true });
  const b = t.service.refresh({ force: true, runtime: "claude" });
  await t.advance(10 * MIN);
  assert.equal(t.calls.probe, 1);
  pending.resolve({ kind: "reading", reading: { status: "ok", windows: claudeWindows(10, t.h.now + 60 * MIN), observedAt: t.h.now, source: "probe" }, claudeStatus: "allowed", auth: AUTH });
  await Promise.all([a, b]);
  assert.equal(t.calls.probe, 1);
});

test("a running turn skips the automatic probe; its own reading is folded in and pushed", async () => {
  const t = harness();
  t.service.connectClient();
  await t.service.refresh({ force: true });
  const end = t.capture.turnStarted("claude");
  await t.advance(10 * MIN);
  assert.equal(t.calls.probe, 1);
  t.capture.claudeEvent({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.55, resetsAt: Math.round((t.h.now + 2 * 60 * MIN) / 1000) } } },
  });
  end();
  assert.equal(t.claude()?.windows[0]?.usedPercent, 55);
  assert.equal(t.claude()?.source, "turn");
  assert.equal(t.messages.at(-1)?.runtimes[0]?.windows[0]?.usedPercent, 55);
  // The turn's reading restarted the 4-min cadence.
  await t.advance(3 * MIN);
  assert.equal(t.calls.probe, 1);
  await t.advance(MIN);
  assert.equal(t.calls.probe, 2);
});

test("kill switch: neither the cadence nor the button probes; the login is still read", async () => {
  const t = harness({ probeEnabled: false });
  t.h.activity = true;
  t.service.connectClient();
  await t.service.refresh({ force: true });
  await t.advance(30 * MIN);
  assert.equal(t.calls.probe, 0);
  assert.ok(t.calls.auth >= 1);
  assert.equal(t.claude()?.plan?.label, "Max 5x");
});

test("API key login: no_subscription, and the button doesn't probe", async () => {
  const t = harness();
  t.h.auth = () => Promise.resolve({ loggedIn: true, authMethod: "api_key", email: EMAIL });
  t.service.connectClient();
  await settle();
  assert.equal(t.claude()?.status, "no_subscription");
  await t.service.refresh({ force: true });
  assert.equal(t.calls.probe, 0);
  assert.equal(t.claude()?.plan, undefined);
  assert.equal(t.claude()?.accountKey, undefined);
});

test("a failed probe keeps the last data and backs off", async () => {
  const t = harness();
  t.service.connectClient();
  await t.service.refresh({ force: true });
  t.h.probe = () => Promise.resolve({ kind: "error", error: "network", probed: true });
  await t.advance(CLAUDE_PROBE_INTERVAL_MS);
  assert.equal(t.calls.probe, 2);
  assert.equal(t.claude()?.status, "error");
  assert.equal(t.claude()?.windows[0]?.usedPercent, 40);
  // 1 min backoff, then 2 min: no probe in between.
  await t.advance(MIN);
  assert.equal(t.calls.probe, 3);
  await t.advance(MIN);
  assert.equal(t.calls.probe, 3);
  await t.advance(MIN);
  assert.equal(t.calls.probe, 4);
});

test("codex: read on connect and every minute, pushes merge by limit, a finished turn pulls", async () => {
  const t = harness({ installed: ["codex"] });
  t.service.connectClient();
  await settle();
  assert.equal(t.calls.codexRead, 1);
  assert.equal(t.codex()?.plan?.label, "Plus");
  assert.match(t.codex()?.accountKey ?? "", /^[0-9a-f]{16}$/);
  await t.advance(MIN);
  assert.equal(t.calls.codexRead, 2);

  // A push for the account bucket carrying only the 5h window keeps the 7d.
  t.capture.codexNotification("account/rateLimits/updated", {
    rateLimits: { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: Math.round((t.h.now + 60 * MIN) / 1000) }, secondary: null },
  });
  assert.deepEqual(
    t.codex()?.windows.map((window) => window.usedPercent),
    [25, 30],
  );
  // An empty per-model bucket changes nothing.
  const before = t.messages.length;
  t.capture.codexNotification("account/rateLimits/updated", { rateLimits: { limitId: "premium", primary: null, secondary: null } });
  assert.equal(t.messages.length, before);

  // The reader's own pushes land too.
  t.h.codexUpdate?.({ status: "ok", windows: [{ durationMins: 300, usedPercent: 27, resetsAt: t.h.now + 60 * MIN, limitId: "codex" }], observedAt: t.h.now, source: "app_server_push" });
  assert.equal(t.codex()?.windows[0]?.usedPercent, 27);

  const end = t.capture.turnStarted("codex");
  end();
  await settle();
  assert.equal(t.calls.codexRead, 3);
});

test("codex: signed out and the card opening", async () => {
  const t = harness({ installed: ["codex"] });
  t.h.codex = () => Promise.resolve({ kind: "auth", status: "signed_out" });
  await t.service.refresh({ force: false });
  assert.equal(t.codex()?.status, "signed_out");
  assert.equal(t.calls.codexRead, 1);
});

test("only installed runtimes are reported; installing one notifies", () => {
  const t = harness({ installed: [] });
  assert.deepEqual(t.service.getSnapshot().runtimes, []);
  t.service.setInstalledRuntimes(["codex", "gemini"]);
  assert.deepEqual(
    t.messages.at(-1)?.runtimes.map((usage) => usage.runtime),
    ["codex"],
  );
});

test("no e-mail, UUID or tier string reaches a subscriber", async () => {
  const t = harness({ installed: ["claude", "codex"] });
  t.service.connectClient();
  await t.service.refresh({ force: true });
  const serialized = JSON.stringify([...t.messages, t.service.getSnapshot()]);
  for (const leaked of [EMAIL, ORG, ACCOUNT, "default_claude_max_5x", "example.invalid"]) assert.ok(!serialized.includes(leaked), leaked);
  assert.ok(!t.h.logs.join("\n").includes("example.invalid"));
});

test("a stored snapshot is the starting state, and every change is saved", async () => {
  const saved: RuntimePlanUsage[][] = [];
  const stored: RuntimePlanUsage = { runtime: "claude", status: "ok", windows: claudeWindows(66, NOW + 60 * MIN), observedAt: NOW - 10 * MIN };
  const t = harness({ store: { load: () => [stored], save: (runtimes) => saved.push(runtimes) } });
  assert.equal(t.claude()?.windows[0]?.usedPercent, 66);
  // Known active window from the snapshot: the cadence may probe after a restart.
  t.service.connectClient();
  await settle();
  assert.equal(t.calls.probe, 1);
  assert.ok(saved.length > 0);
  assert.equal(saved.at(-1)?.find((usage) => usage.runtime === "claude")?.windows[0]?.usedPercent, 40);
});

test("a read in flight is announced: reading/readingSince pushed when it starts, cleared by the push with its result", async () => {
  const t = harness({ installed: ["claude", "codex"] });
  const pending = deferred<ClaudeUsageProbeResult>();
  t.h.probe = () => pending.promise;
  const started = t.h.now;
  const refresh = t.service.refresh({ force: true, runtime: "claude" });
  const during = t.messages.at(-1)?.runtimes.find((usage) => usage.runtime === "claude");
  assert.equal(during?.reading, true);
  assert.equal(during?.readingSince, started);
  assert.equal(t.claude()?.reading, true);
  // Only the runtime being read says so.
  assert.equal(t.codex()?.reading, undefined);

  pending.resolve({ kind: "reading", reading: { status: "ok", windows: claudeWindows(12, t.h.now + 60 * MIN), observedAt: t.h.now, source: "probe" }, claudeStatus: "allowed", auth: AUTH });
  await refresh;
  const after = t.messages.at(-1)?.runtimes.find((usage) => usage.runtime === "claude");
  assert.equal(after?.reading, undefined);
  assert.equal(after?.readingSince, undefined);
  assert.equal(after?.windows[0]?.usedPercent, 12);
  // The result's own push already said the read had ended.
  assert.ok(t.messages.every((message) => !(message.runtimes.find((usage) => usage.runtime === "claude")?.windows[0]?.usedPercent === 12 && message.runtimes.find((usage) => usage.runtime === "claude")?.reading)));
});

test("a read whose result changes nothing still pushes that it ended", async () => {
  const t = harness({ installed: ["codex"] });
  t.service.connectClient();
  await settle();
  // An answer older than what is held is ignored by the ingest.
  t.h.codex = () =>
    Promise.resolve({
      kind: "reading",
      reading: { status: "ok", windows: [{ durationMins: 300, usedPercent: 1, resetsAt: t.h.now + 60 * MIN, limitId: "codex" }], observedAt: t.h.now - 10 * MIN, source: "app_server_read" },
      identity: null,
    });
  const before = t.messages.length;
  await t.service.refresh({ force: false });
  const pushed = t.messages.slice(before).map((message) => message.runtimes[0]?.reading);
  assert.deepEqual(pushed, [true, undefined]);
});

test("reading is never persisted", async () => {
  const saved: RuntimePlanUsage[][] = [];
  const t = harness({ store: { load: () => undefined, save: (runtimes) => saved.push(runtimes) } });
  const pending = deferred<ClaudeUsageProbeResult>();
  t.h.probe = () => pending.promise;
  const refresh = t.service.refresh({ force: true });
  pending.resolve({ kind: "error", error: "network", probed: true });
  await refresh;
  assert.ok(saved.length > 0);
  assert.ok(!JSON.stringify(saved).includes("reading"));
});

test("a stored snapshot with an active window resumes the cadence without probing, its age exposed", async () => {
  const observedAt = NOW - 30_000;
  const stored: RuntimePlanUsage = {
    runtime: "claude",
    status: "ok",
    windows: claudeWindows(66, NOW + 2 * 60 * MIN),
    plan: { family: "max", label: "Max 5x" },
    observedAt,
    source: "probe",
  };
  const t = harness({ store: { load: () => [stored], save: () => {} } });
  // Shown at once, with the time it was read — the client's "updated 30s ago".
  assert.equal(t.claude()?.windows[0]?.usedPercent, 66);
  assert.equal(t.claude()?.observedAt, observedAt);
  assert.equal(t.claude()?.source, "probe");
  // No client: nothing scheduled.
  assert.equal(t.claude()?.nextAutoRefreshAt, null);

  t.service.connectClient();
  await settle();
  // Within the connect floor: no probe, the next one due 4 min after the stored reading.
  assert.equal(t.calls.probe, 0);
  assert.equal(t.claude()?.nextAutoRefreshAt, observedAt + CLAUDE_PROBE_INTERVAL_MS);
  await t.advance(CLAUDE_PROBE_INTERVAL_MS - 2 * MIN);
  assert.equal(t.calls.probe, 0);
  await t.advance(2 * MIN);
  assert.equal(t.calls.probe, 1);
});

test("a stored snapshot whose 5h window expired shows 0 % and is not probed", async () => {
  const stored: RuntimePlanUsage = { runtime: "claude", status: "ok", windows: claudeWindows(80, NOW - MIN), observedAt: NOW - 3 * 60 * MIN, source: "probe" };
  const t = harness({ store: { load: () => [stored], save: () => {} } });
  t.service.connectClient();
  await t.advance(20 * MIN);
  assert.equal(t.calls.probe, 0);
  assert.equal(t.claude()?.windows[0]?.usedPercent, 0);
  assert.equal(t.claude()?.windows[1]?.usedPercent, 20);
});

test("never read, but a transcript records a limit still running: limited until its reset, without probing", async () => {
  const t = harness();
  const reset = NOW + 40 * MIN;
  t.h.transcriptLimit = { window: { durationMins: 300, usedPercent: 100, resetsAt: reset }, observedAt: NOW - 20 * MIN };
  t.h.activity = true;
  t.service.connectClient();
  await settle();
  assert.equal(t.calls.transcript, 1);
  assert.equal(t.claude()?.status, "limited");
  assert.equal(t.claude()?.source, "transcript");
  assert.deepEqual(t.claude()?.windows, [{ durationMins: 300, usedPercent: 100, resetsAt: reset }]);
  assert.equal(t.claude()?.observedAt, NOW - 20 * MIN);
  // Limited inside its window: nothing probes, and the files aren't re-read while the window runs.
  await t.advance(30 * MIN);
  assert.equal(t.calls.probe, 0);
  assert.equal(t.calls.transcript, 1);
  // After the reset the old 100 % is never shown. (With no local use since:
  // a recent write after a known reset would now allow a probe.)
  t.h.activity = false;
  await t.advance(15 * MIN);
  assert.equal(t.claude()?.windows[0]?.usedPercent, 0);
  assert.equal(t.claude()?.status, "ok");
});

test("a transcript limit older than what the relay already read is ignored", async () => {
  const stored: RuntimePlanUsage = { runtime: "claude", status: "ok", windows: claudeWindows(30, NOW - MIN), observedAt: NOW - 2 * MIN, source: "probe" };
  const t = harness({ store: { load: () => [stored], save: () => {} } });
  t.h.transcriptLimit = { window: { durationMins: 300, usedPercent: 100, resetsAt: NOW + 60 * MIN }, observedAt: NOW - 30 * MIN };
  t.service.connectClient();
  await settle();
  assert.equal(t.calls.transcript, 1);
  assert.equal(t.claude()?.source, "probe");
  assert.notEqual(t.claude()?.status, "limited");
});
