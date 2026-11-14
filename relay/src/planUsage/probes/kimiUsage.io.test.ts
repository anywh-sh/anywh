import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { kimiRuntimeDef } from "../../runtimes/defs/kimi.js";
import { createKimiUsageReader, kimiHasCredentials } from "./kimiUsage.js";

// Against `tests/fixtures/fake-kimi-web.mjs` (the routes and shapes of Kimi
// Code CLI 2.6.0's `kimi web`): proves the reader's process handling, not
// Kimi's backend.
const FAKE = resolve(import.meta.dirname, "../../../tests/fixtures/fake-kimi-web.mjs");
const def = { ...kimiRuntimeDef, identity: { ...kimiRuntimeDef.identity, bin: FAKE } };

function profile(loggedIn: boolean): { home: string; log: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "kimi-usage-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
  if (loggedIn) writeFileSync(join(home, ".kimi-code", "credentials", "kimi-code.json"), "{}");
  return { home, log: join(root, "web.log"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The fake reads its knobs from the environment the child inherits, which
 * is the relay's own (`buildChildEnv`), not the reader's `env` option. */
function withFakeEnv(vars: Record<string, string>): () => void {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function lines(log: string): string[] {
  try {
    return readFileSync(log, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("a logged-in profile is read through one kimi web kept up between reads", async () => {
  const p = profile(true);
  const restore = withFakeEnv({ FAKE_KIMI_WEB_LOG: p.log });
  const reader = createKimiUsageReader({ homeOverride: p.home, def, env: { KIMI_CODE_HOME: "" }, now: () => 42 });
  try {
    const first = await reader.read();
    assert.equal(first.kind, "reading");
    if (first.kind !== "reading") return;
    assert.deepEqual(first.reading.windows.map((window) => [window.durationMins, window.usedPercent]), [[300, 25], [43200, 12.4]]);
    assert.deepEqual(first.reading.plan, { family: "plus", label: "Plus" });
    assert.equal(first.reading.source, "cli_server_read");
    assert.equal(first.userId, "user-1");
    assert.ok(!JSON.stringify(first).includes("example.invalid"), "the e-mail the route carries is never read");
    await reader.read();
    assert.equal(lines(p.log).filter((line) => line.startsWith("start")).length, 1, "one server for both reads");
  } finally {
    reader.close();
    restore();
    p.cleanup();
  }
});

test("no credentials: signed_out, and nothing is spawned", async () => {
  const p = profile(false);
  const restore = withFakeEnv({ FAKE_KIMI_WEB_LOG: p.log });
  const reader = createKimiUsageReader({ homeOverride: p.home, def, env: { KIMI_CODE_HOME: "" } });
  try {
    assert.deepEqual(await reader.read(), { kind: "auth", status: "signed_out" });
    restore();
    assert.deepEqual(lines(p.log), []);
    assert.equal(kimiHasCredentials(join(p.home, ".kimi-code")), false);
  } finally {
    p.cleanup();
  }
});

test("a login the server no longer accepts is signed_out", async () => {
  const p = profile(true);
  const restore = withFakeEnv({ FAKE_KIMI_WEB_STATE: "signed_out" });
  const reader = createKimiUsageReader({ homeOverride: p.home, def, env: { KIMI_CODE_HOME: "" } });
  try {
    assert.deepEqual(await reader.read(), { kind: "auth", status: "signed_out" });
  } finally {
    reader.close();
    restore();
    p.cleanup();
  }
});

test("a binary that never comes up is an error, not a hang", async () => {
  const p = profile(true);
  const broken = { ...def, identity: { ...def.identity, bin: "/nonexistent/kimi" } };
  const reader = createKimiUsageReader({ homeOverride: p.home, def: broken, env: { KIMI_CODE_HOME: "" }, startTimeoutMs: 2000 });
  try {
    assert.deepEqual(await reader.read(), { kind: "error", error: "unknown" });
  } finally {
    reader.close();
    p.cleanup();
  }
});

test("close stops the server; the next read starts another", async () => {
  const p = profile(true);
  const restore = withFakeEnv({ FAKE_KIMI_WEB_LOG: p.log });
  const reader = createKimiUsageReader({ homeOverride: p.home, def, env: { KIMI_CODE_HOME: "" } });
  try {
    assert.equal((await reader.read()).kind, "reading");
    reader.close();
    assert.equal((await reader.read()).kind, "reading");
    assert.equal(lines(p.log).filter((line) => line.startsWith("start")).length, 2);
  } finally {
    reader.close();
    restore();
    p.cleanup();
  }
});
