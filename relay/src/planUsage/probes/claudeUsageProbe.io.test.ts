// The probe's real spawns against the fake `claude` (tests/fixtures/
// fake-claude.mjs, the sanctioned boundary): which flags, env and cwd the
// child actually gets. `bin` is always the fake — nothing here may reach the
// real CLI, whose probe would be a real turn on a real subscription.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLAUDE_USAGE_PROBE_ARGS, defaultClaudeUsageProbeDeps, probeClaudeUsage } from "./claudeUsageProbe.js";

const FAKE_CLAUDE = resolve(fileURLToPath(import.meta.url), "../../../../tests/fixtures/fake-claude.mjs");

const root = mkdtempSync(join(tmpdir(), "claude-usage-probe-"));
const home = join(root, "home");
const cwd = join(root, "usage-probe");
const invocations = join(root, "invocations.jsonl");
const loggedOut = join(root, "logged-out");
const rejected = join(root, "rejected");

process.env.FAKE_CLAUDE_INVOCATIONS_FILE = invocations;
process.env.FAKE_CLAUDE_LOGGED_OUT_FILE = loggedOut;
process.env.FAKE_CLAUDE_RATE_LIMIT_REJECTED_FILE = rejected;
// A billed credential in the relay's own env must never reach the probe.
Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-ant-test-not-a-key" });

after(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  for (const file of [invocations, loggedOut, rejected]) rmSync(file, { force: true });
  delete process.env.FAKE_CLAUDE_AUTH_METHOD;
});

interface Invocation {
  args: string[];
  cwd: string;
  home: string;
  billedCredentials: string[];
}

function readInvocations(): Invocation[] {
  if (!existsSync(invocations)) return [];
  return readFileSync(invocations, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}

const deps = () => defaultClaudeUsageProbeDeps({ bin: FAKE_CLAUDE, cwd });

test("a subscription login is checked, then probed in an empty dir without billed credentials", async () => {
  const result = await probeClaudeUsage(home, deps());
  assert.equal(result.kind, "reading");
  if (result.kind !== "reading") return;
  assert.equal(result.reading.status, "ok");
  assert.deepEqual(
    result.reading.windows.map((window) => [window.durationMins, window.usedPercent]),
    [
      [300, 42],
      [10080, 17],
    ],
  );
  assert.equal(result.reading.plan?.label, "Pro");

  const [authCheck, probe, ...rest] = readInvocations();
  assert.equal(rest.length, 0);
  assert.deepEqual(authCheck?.args, ["auth", "status", "--json"]);
  assert.deepEqual(probe?.args, [...CLAUDE_USAGE_PROBE_ARGS]);
  assert.ok(probe?.args.includes("--no-session-persistence"));
  for (const invocation of [authCheck, probe]) {
    assert.equal(invocation?.home, home, "the profile's HOME");
    assert.deepEqual(invocation?.billedCredentials, [], "ANTHROPIC_API_KEY stripped");
  }
  assert.equal(probe?.cwd, cwd);
  assert.deepEqual(readdirSync(cwd), [], "the probe's cwd stays empty");
});

test("signed out: the auth check runs, the probe never does", async () => {
  writeFileSync(loggedOut, "");
  const result = await probeClaudeUsage(home, deps());
  assert.equal(result.kind === "auth" && result.status, "signed_out");
  assert.deepEqual(
    readInvocations().map((invocation) => invocation.args[0]),
    ["auth"],
  );
});

test("an API key login is not probed", async () => {
  process.env.FAKE_CLAUDE_AUTH_METHOD = "api_key";
  const result = await probeClaudeUsage(home, deps());
  assert.equal(result.kind === "auth" && result.status, "no_subscription");
  assert.equal(readInvocations().length, 1);
});

test("an account at its limit reads as limited", async () => {
  writeFileSync(rejected, "");
  const result = await probeClaudeUsage(home, deps());
  assert.equal(result.kind, "reading");
  if (result.kind !== "reading") return;
  assert.equal(result.claudeStatus, "rejected");
  assert.equal(result.reading.status, "limited");
});

test("a CLI that can't be spawned is an error", async () => {
  const result = await probeClaudeUsage(home, defaultClaudeUsageProbeDeps({ bin: join(root, "missing-claude"), cwd }));
  assert.deepEqual(result, { kind: "error", error: "unknown", probed: false });
});
