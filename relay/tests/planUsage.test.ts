// /plan-usage/watch and GET /plan-usage against the real relay: the fake
// `claude` answers turns, `auth status` and the usage probe (each with a
// `rate_limit_event`), and a `codex` wrapper on the PATH makes Codex count as
// installed while its home has no login. Proves the wiring — capture →
// service → socket, refresh → probe — never the CLIs' behaviour.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type WebSocket from "ws";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectPlanUsageWatchAndCollectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

const work = mkdtempSync(join(tmpdir(), "anywh-plan-usage-it-"));
const invocationsFile = join(work, "claude-invocations.jsonl");
const rateLimitFile = join(work, "rate-limit.json");
const rejectedFile = join(work, "rejected");
const binDir = join(work, "bin");
mkdirSync(binDir);
// Only `--version` matters: detection must find Codex installed. With no
// auth.json in the profile's home the reader never spawns it.
writeFileSync(join(binDir, "codex"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.154.0"; exit 0; fi\nexit 1\n');
chmodSync(join(binDir, "codex"), 0o755);

process.env.FAKE_CLAUDE_INVOCATIONS_FILE = invocationsFile;
process.env.FAKE_CLAUDE_RATE_LIMIT_FILE = rateLimitFile;
process.env.FAKE_CLAUDE_RATE_LIMIT_REJECTED_FILE = rejectedFile;
process.env.PATH = [binDir, ...(process.env.PATH ?? "").split(delimiter).filter((entry) => entry && !existsSync(join(entry, "codex")))].join(delimiter);
process.env.EXTRA_PATH_DIRS = "";
// The button's 60 s floor between probes would answer the forced refreshes
// below from the cache (the floors are covered in service.test.ts).
process.env.ANYWH_PLAN_USAGE_CLAUDE_FORCE_FLOOR_MS = "0";
// A billed credential in the relay's own env: the probe must not carry it.
process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-not-a-real-key";

let server: TestServer;
let watcher: WebSocket;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  watcher?.close();
  await server.close();
  rmSync(work, { recursive: true, force: true });
});

type State = { type: string; runtimes: { runtime: string; status: string; windows: { durationMins: number; usedPercent: number; resetsAt: number | null }[]; source?: string; plan?: { label: string }; accountKey?: string; everSignedIn?: boolean }[] };

const isState = (message: Record<string, unknown>): message is Record<string, unknown> & State => message.type === "plan_usage_state";
const claudeOf = (message: State) => message.runtimes.find((usage) => usage.runtime === "claude");
const codexOf = (message: State) => message.runtimes.find((usage) => usage.runtime === "codex");

function invocations(): { args: string[]; billedCredentials: string[] }[] {
  if (!existsSync(invocationsFile)) return [];
  return readFileSync(invocationsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; billedCredentials: string[] });
}

const probes = () => invocations().filter(({ args }) => args[0] === "-p" && args[1] === "ok" && args.includes("--max-turns"));

async function turn(sessionId: string): Promise<void> {
  const socket = await connectSession(server.port, sessionId);
  sendUserMessage(socket, "hello");
  await collectUntil(socket, isTurnEnded, 15_000);
  socket.close();
}

test("the snapshot comes first, without protocol_version; unknown Claude is not probed, Codex without login is signed_out", async () => {
  // The account ids behind Claude's account key (never sent).
  writeFileSync(join(server.homeDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acc-uuid-it", organizationUuid: "org-uuid-it" } }));
  const { socket, messages } = await connectPlanUsageWatchAndCollectUntil(
    server.port,
    (message) => isState(message) && codexOf(message)?.status === "signed_out" && claudeOf(message)?.plan?.label === "Pro",
    15_000,
  );
  watcher = socket;
  assert.equal(messages[0]?.type, "plan_usage_state");
  assert.ok(messages.every((message) => message.type !== "protocol_version"));
  const last = messages.at(-1) as State;
  assert.equal(claudeOf(last)?.status, "unknown");
  assert.match(claudeOf(last)?.accountKey ?? "", /^[0-9a-f]{16}$/);
  assert.equal(probes().length, 0);
  // Codex: no auth.json and no session history in this profile's home — never used here.
  assert.equal(codexOf(last)?.everSignedIn, false);
  // Claude: the login check found a claude.ai login.
  assert.equal(claudeOf(last)?.everSignedIn, true);
});

test("ping is answered with pong; malformed or unknown commands are ignored", async () => {
  watcher.send("not json");
  watcher.send(JSON.stringify({ type: "plan_usage_refresh", force: true, runtime: "gemini" }));
  watcher.send(JSON.stringify({ type: "plan_usage_refresh", force: "yes" }));
  watcher.send(JSON.stringify({ type: "ping" }));
  const messages = await collectUntil(watcher, (message) => message.type === "pong");
  assert.ok(messages.every((message) => message.type !== "protocol_version"));
  assert.equal(probes().length, 0);
});

test("a turn's reading is pushed; an expired window shows 0 % and is not probed without force", async () => {
  const past = Math.floor(Date.now() / 1000) - 600;
  writeFileSync(
    rateLimitFile,
    JSON.stringify({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: past }, seven_day: { utilization: 0.3, resetsAt: past + 3 * 86400 } } }),
  );
  const pushed = collectUntil(watcher, (message) => isState(message) && claudeOf(message)?.source === "turn", 15_000);
  await turn("plan-usage-expired");
  const state = (await pushed).at(-1) as State;
  assert.deepEqual(
    claudeOf(state)?.windows.map((window) => [window.durationMins, window.usedPercent]),
    [
      [300, 0],
      [10080, 30],
    ],
  );
  // A new watcher, and a card opening (force: false): still no probe.
  const second = await connectPlanUsageWatchAndCollectUntil(server.port, isState);
  second.socket.send(JSON.stringify({ type: "plan_usage_refresh", force: false }));
  await collectUntil(second.socket, isState);
  second.socket.close();
  assert.equal(probes().length, 0);

  rmSync(rateLimitFile);
  const live = collectUntil(watcher, (message) => isState(message) && claudeOf(message)?.windows[0]?.usedPercent === 42, 15_000);
  await turn("plan-usage-live");
  await live;
});

test("the refresh button probes, with the probe's flags and without the billed credential", async () => {
  const before = probes().length;
  watcher.send(JSON.stringify({ type: "plan_usage_refresh", force: true, runtime: "claude" }));
  await collectUntil(watcher, (message) => isState(message) && claudeOf(message)?.source === "probe", 15_000);
  const made = probes().slice(before);
  assert.equal(made.length, 1);
  for (const flag of ["--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(made[0]?.args.includes(flag), flag);
  assert.deepEqual(made[0]?.billedCredentials, []);
});

test("a limited account: the forced probe reports it", async () => {
  writeFileSync(rejectedFile, "");
  watcher.send(JSON.stringify({ type: "plan_usage_refresh", force: true }));
  const state = (await collectUntil(watcher, (message) => isState(message) && claudeOf(message)?.status === "limited", 15_000)).at(-1) as State;
  assert.equal(claudeOf(state)?.windows[0]?.usedPercent, 100);
  rmSync(rejectedFile);
});

test("GET /plan-usage returns the same snapshot, with no e-mail or account id in it", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/plan-usage`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as State;
  assert.equal(body.type, "plan_usage_state");
  assert.deepEqual(
    body.runtimes.map((usage) => usage.runtime),
    ["claude", "codex"],
  );
  for (const leaked of ["anywh.test", "uuid-it"]) assert.ok(!JSON.stringify(body).includes(leaked), leaked);
});
