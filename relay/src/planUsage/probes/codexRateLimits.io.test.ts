// The Codex rate limits reader against a real child process speaking real
// JSON-RPC: tests/fixtures/fake-codex-app-server.mjs, which answers with the
// samples recorded in tests/fixtures/codex-app-server-0.154.0-rate-limits.json.
// This proves the wiring (spawn, handshake, the two reads, the push, the
// timeouts), never Codex's behaviour. The paid plan sample was not measured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexRuntimeDef } from "../../runtimes/defs/codex.js";
import { spawnCodexDaemon } from "../../runtimes/transports/codexDaemon.js";
import type { AgentRuntimeDef } from "../../runtimes/types.js";
import { codexHomeDir, createCodexRateLimitsReader, type CodexRateLimitsReaderOptions } from "./codexRateLimits.js";
import type { PlanUsageReading } from "../ingest.js";
import { CODEX_ACCOUNT_LIMIT_ID, parseCodexAccount, parseCodexRateLimitsRead } from "../codexLimits.js";

const FIXTURES = resolve(import.meta.dirname, "../../../tests/fixtures");
const FAKE_CODEX = join(FIXTURES, "fake-codex-app-server.mjs");

interface Sample {
  measured: boolean;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}
const fixture = JSON.parse(readFileSync(join(FIXTURES, "codex-app-server-0.154.0-rate-limits.json"), "utf8")) as {
  cliVersion: string;
  samples: Record<string, Sample>;
};

const NOW = 1_793_330_000_000;

function fakeDef(env: Record<string, string>): AgentRuntimeDef {
  return { ...codexRuntimeDef, identity: { ...codexRuntimeDef.identity, bin: FAKE_CODEX, env: { ...codexRuntimeDef.identity.env, set: env } } };
}

/** A profile home whose CODEX_HOME has (or not) an auth.json, and a file the
 * fake logs every request to. */
function setup(t: { after: (fn: () => void) => void }, options: { loggedIn?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "anywh-codex-limits-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".codex"));
  if (options.loggedIn !== false) writeFileSync(join(home, ".codex", "auth.json"), "{}");
  const requestsFile = join(home, "requests.jsonl");
  const requests = (): { method: string; params?: unknown }[] => {
    try {
      return readFileSync(requestsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params?: unknown });
    } catch {
      return [];
    }
  };
  return { home, requestsFile, requests };
}

function reader(t: { after: (fn: () => void) => void }, home: string, env: Record<string, string>, extra: Partial<CodexRateLimitsReaderOptions> = {}) {
  const created = createCodexRateLimitsReader({ homeOverride: home, env: {}, def: fakeDef(env), now: () => NOW, ...extra });
  t.after(() => created.close());
  return created;
}

test("fixture: recorded from 0.154.0, and only the paid plan samples are unmeasured", () => {
  assert.equal(fixture.cliVersion, "0.154.0");
  const unmeasured = Object.entries(fixture.samples)
    .filter(([, sample]) => !sample.measured)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(unmeasured, ["accountReadChatgptPlus", "rateLimitsReadPaid", "rateLimitsUpdatedPaid"]);
  // The pure parsers accept every recorded reply.
  assert.deepEqual(parseCodexAccount(fixture.samples.accountReadChatgptFree.result), { kind: "chatgpt", planType: "free" });
  assert.ok(parseCodexRateLimitsRead(fixture.samples.rateLimitsReadFree.result)?.buckets[CODEX_ACCOUNT_LIMIT_ID]);
});

test("codexHomeDir: CODEX_HOME wins, else ~/.codex of the profile home", () => {
  assert.equal(codexHomeDir("/p", { CODEX_HOME: "/elsewhere" }), "/elsewhere");
  assert.equal(codexHomeDir("/p", {}), "/p/.codex");
  assert.equal(codexHomeDir(undefined, { HOME: "/h" }), "/h/.codex");
});

test("no auth.json: signed_out without spawning anything", async (t) => {
  const { home } = setup(t, { loggedIn: false });
  let spawned = 0;
  const codex = reader(t, home, {}, {
    spawnDaemon: (options) => {
      spawned++;
      return spawnCodexDaemon(options);
    },
  });
  assert.deepEqual(await codex.read(), { kind: "auth", status: "signed_out" });
  assert.equal(spawned, 0);
});

test("free plan (measured): one 30-day window, limited, plan Free, no PII in the reading", async (t) => {
  const { home, requestsFile, requests } = setup(t);
  const codex = reader(t, home, { FAKE_CODEX_REQUESTS: requestsFile });
  const result = await codex.read();
  assert.equal(result.kind, "reading");
  if (result.kind !== "reading") return;
  assert.deepEqual(result.reading, {
    status: "limited",
    windows: [{ durationMins: 43200, usedPercent: 100, resetsAt: 1795025523000, limitId: "codex" }],
    observedAt: NOW,
    source: "app_server_read",
    plan: { family: "free", label: "Free" },
  });
  // The e-mail only travels in `identity`, for the account key.
  assert.deepEqual(result.identity, { email: "redacted@example.invalid", planType: "free" });
  const serialized = JSON.stringify(result.reading);
  for (const leak of ["redacted@example.invalid", "redacted-account-id", "Try Plus", "banner_type"]) assert.ok(!serialized.includes(leak), leak);

  const methods = requests().map((request) => request.method);
  assert.deepEqual(methods, ["initialize", "account/read", "account/rateLimits/read"]);
  assert.deepEqual(requests()[2].params, { excludeResetCreditDetails: true });
});

test("paid plan (synthetic, NOT measured): 5h + 7d classified by duration, per-model bucket hidden", async (t) => {
  const { home } = setup(t);
  const codex = reader(t, home, { FAKE_CODEX_ACCOUNT: "plus" });
  const result = await codex.read();
  assert.equal(result.kind, "reading");
  if (result.kind !== "reading") return;
  assert.equal(result.reading.status, "ok");
  assert.deepEqual(result.reading.plan, { family: "plus", label: "Plus" });
  assert.deepEqual(
    result.reading.windows.map((window) => [window.durationMins, window.usedPercent, window.limitId]),
    [
      [300, 37, "codex"],
      [10080, 12, "codex"],
    ],
  );
});

test("API key login: no_subscription; account null with an auth.json: signed_out", async (t) => {
  const { home } = setup(t);
  assert.deepEqual(await reader(t, home, { FAKE_CODEX_ACCOUNT: "api_key" }).read(), { kind: "auth", status: "no_subscription" });
  assert.deepEqual(await reader(t, home, { FAKE_CODEX_ACCOUNT: "signed_out" }).read(), { kind: "auth", status: "signed_out" });
});

test("push after a read: an account bucket merges (null keeps the 7d), an empty per-model bucket is dropped", async (t) => {
  const { home } = setup(t);
  const updates: PlanUsageReading[] = [];
  const paid = reader(t, home, { FAKE_CODEX_ACCOUNT: "plus", FAKE_CODEX_PUSH_AFTER_READ: "1" }, { onUpdate: (reading) => updates.push(reading) });
  await paid.read();
  await waitFor(() => updates.length > 0);
  assert.equal(updates[0].source, "app_server_push");
  assert.deepEqual(
    updates[0].windows.map((window) => [window.durationMins, window.usedPercent, window.resetsAt]),
    [
      [300, 41, 1793340001000],
      [10080, 12, 1793800000000],
    ],
  );

  const freeUpdates: PlanUsageReading[] = [];
  const second = setup(t);
  const { requestsFile, requests } = second;
  const free = reader(t, second.home, { FAKE_CODEX_PUSH_AFTER_READ: "1", FAKE_CODEX_REQUESTS: requestsFile }, { onUpdate: (reading) => freeUpdates.push(reading) });
  await free.read();
  // A second read on the same process: the push of the first one has been
  // handled by the time its reply arrives.
  await free.read();
  assert.deepEqual(freeUpdates, []);
  assert.equal(requests().filter((request) => request.method === "initialize").length, 1);
});

test("the app-server is reused across reads, concurrent reads share one, close() stops it", async (t) => {
  const { home, requestsFile, requests } = setup(t);
  let spawned = 0;
  const codex = reader(t, home, { FAKE_CODEX_REQUESTS: requestsFile }, {
    spawnDaemon: (options) => {
      spawned++;
      return spawnCodexDaemon(options);
    },
  });
  const [first, second] = await Promise.all([codex.read(), codex.read()]);
  assert.equal(first, second);
  await codex.read();
  assert.equal(spawned, 1);
  assert.equal(requests().filter((request) => request.method === "account/rateLimits/read").length, 2);

  codex.close();
  assert.equal((await codex.read()).kind, "reading");
  assert.equal(spawned, 2);
  // Reading never starts a thread or a turn.
  assert.ok(requests().every((request) => request.method === "initialize" || request.method.startsWith("account/")));
});

test("a read that never answers: network error after the RPC timeout, and the next read starts over", async (t) => {
  const { home } = setup(t);
  let spawned = 0;
  const codex = reader(t, home, { FAKE_CODEX_RATE_LIMITS_HANG: "1" }, {
    requestTimeoutMs: 300,
    spawnDaemon: (options) => {
      spawned++;
      return spawnCodexDaemon(options);
    },
  });
  assert.deepEqual(await codex.read(), { kind: "error", error: "network" });
  assert.deepEqual(await codex.read(), { kind: "error", error: "network" });
  assert.equal(spawned, 2);
});

test("a codex that is not installed: error, never a rejection", async (t) => {
  const { home } = setup(t);
  const codex = createCodexRateLimitsReader({
    homeOverride: home,
    env: {},
    def: { ...codexRuntimeDef, identity: { ...codexRuntimeDef.identity, bin: join(home, "no-such-codex") } },
  });
  t.after(() => codex.close());
  assert.deepEqual(await codex.read(), { kind: "error", error: "unknown" });
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((done) => setTimeout(done, 10));
  }
}

test("an app-server whose handshake never answers: network error after the init timeout", async (t) => {
  const { home } = setup(t);
  const codex = reader(t, home, {}, { initTimeoutMs: 100, spawnDaemon: () => new Promise(() => {}) });
  assert.deepEqual(await codex.read(), { kind: "error", error: "network" });
});
