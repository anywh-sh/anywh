import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_EVENT_ALLOWED, CLAUDE_EVENT_REJECTED } from "../fixtures.js";
import {
  CLAUDE_USAGE_PROBE_ARGS,
  type ClaudeUsageAuth,
  type ClaudeUsageProbeDeps,
  claudeUsageAuthGate,
  interpretClaudeUsageProbe,
  parseClaudeUsageAuth,
  ProbeTimeoutError,
  probeClaudeUsage,
} from "./claudeUsageProbe.js";

const SUBSCRIPTION: ClaudeUsageAuth = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "user@example.com" };
const NOW = 1_793_330_000_000;

function jsonl(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/** Deps that record what they were asked to run; the probe answers `stdout`. */
function recordingDeps(auth: ClaudeUsageAuth | Error, stdout = jsonl(CLAUDE_EVENT_ALLOWED)) {
  const probes: (readonly string[])[] = [];
  const deps: ClaudeUsageProbeDeps = {
    readAuthStatus: () => (auth instanceof Error ? Promise.reject(auth) : Promise.resolve(auth)),
    runProbe: (_home, args) => {
      probes.push(args);
      return Promise.resolve({ stdout, exitCode: 0 });
    },
    now: () => NOW,
  };
  return { deps, probes };
}

test("the probe runs the minimal turn of journal/99 §1.3", () => {
  const args = CLAUDE_USAGE_PROBE_ARGS;
  const flag = (name: string) => args[args.indexOf(name) + 1];
  assert.equal(args[0], "-p");
  assert.equal(flag("--output-format"), "stream-json");
  assert.ok(args.includes("--verbose"), "stream-json under -p needs --verbose");
  assert.equal(flag("--model"), "haiku");
  assert.equal(flag("--tools"), "");
  assert.equal(flag("--max-turns"), "1");
  for (const required of ["--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]) {
    assert.ok(args.includes(required), `missing ${required}`);
  }
  assert.ok(!args.includes("--bare"), "--bare ignores the OAuth login");
});

test("only a claude.ai login is probed", () => {
  assert.equal(claudeUsageAuthGate(SUBSCRIPTION), "probe");
  assert.equal(claudeUsageAuthGate({ loggedIn: false }), "signed_out");
  assert.equal(claudeUsageAuthGate({ loggedIn: true, authMethod: "api_key" }), "no_subscription");
  // An older CLI that doesn't say how it is logged in could be on an API
  // key the env strip didn't catch: not probed.
  assert.equal(claudeUsageAuthGate({ loggedIn: true, subscriptionType: "max" }), "no_subscription");
});

test("auth status is parsed by field, and anything else is a failure", () => {
  const auth = parseClaudeUsageAuth(
    JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "team", orgId: "org", token: "secret" }),
  );
  assert.deepEqual(auth, { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "team", orgId: "org" });
  assert.throws(() => parseClaudeUsageAuth("not json"));
  assert.throws(() => parseClaudeUsageAuth(JSON.stringify({ authMethod: "claude.ai" })));
});

test("without a subscription nothing is spawned", async () => {
  for (const [auth, status] of [
    [{ loggedIn: false }, "signed_out"],
    [{ loggedIn: true, authMethod: "api_key" }, "no_subscription"],
  ] as const) {
    const { deps, probes } = recordingDeps(auth);
    const result = await probeClaudeUsage(undefined, deps);
    assert.deepEqual(result, { kind: "auth", status, probed: false, auth });
    assert.equal(probes.length, 0);
  }
});

test("an unreadable auth status is an error, not a probe", async () => {
  const { deps, probes } = recordingDeps(new Error("timed out"));
  assert.deepEqual(await probeClaudeUsage(undefined, deps), { kind: "error", error: "unknown", probed: false });
  assert.equal(probes.length, 0);
});

test("a claude.ai login is probed and the event becomes a reading", async () => {
  const { deps, probes } = recordingDeps(SUBSCRIPTION);
  const result = await probeClaudeUsage("/home/profile", deps);
  assert.equal(probes.length, 1);
  assert.equal(result.kind, "reading");
  if (result.kind !== "reading") return;
  assert.equal(result.claudeStatus, "allowed");
  assert.deepEqual(result.reading, {
    status: "ok",
    observedAt: NOW,
    source: "probe",
    plan: { family: "max", label: "Max" },
    windows: [
      { durationMins: 300, usedPercent: 63, resetsAt: 1_793_333_400_000 },
      { durationMins: 10080, usedPercent: 19, resetsAt: 1_793_746_800_000 },
    ],
  });
});

test("a limited account still reports its windows", () => {
  // Recorded order at the limit: the event comes first, then a synthetic
  // reply and a failed result.
  const stdout = jsonl(
    { type: "system", subtype: "init" },
    CLAUDE_EVENT_REJECTED,
    { type: "assistant", message: { content: [{ type: "text", text: "You've hit your session limit" }] } },
    { type: "result", is_error: true, result: "You've hit your session limit" },
  );
  const result = interpretClaudeUsageProbe({ stdout, exitCode: 1 }, SUBSCRIPTION, NOW);
  assert.equal(result.kind, "reading");
  if (result.kind !== "reading") return;
  assert.equal(result.claudeStatus, "rejected");
  assert.equal(result.reading.status, "limited");
  assert.equal(result.reading.windows[0]?.usedPercent, 100);
});

test("an auth failure inside the probe is signed out, never retried", () => {
  for (const text of ["Not logged in · Please run /login", 'API Error: 401 {"type":"authentication_error"}', "OAuth token has expired"]) {
    const result = interpretClaudeUsageProbe({ stdout: jsonl({ type: "result", is_error: true, result: text }), exitCode: 1 }, SUBSCRIPTION, NOW);
    assert.deepEqual(result, { kind: "auth", status: "signed_out", probed: true, auth: SUBSCRIPTION }, text);
  }
  const apiKey = interpretClaudeUsageProbe({ stdout: jsonl({ type: "result", is_error: true, result: "Invalid API key · Fix external API key" }), exitCode: 1 }, SUBSCRIPTION, NOW);
  assert.equal(apiKey.kind === "auth" && apiKey.status, "no_subscription");
});

test("output without an event is an error that keeps no raw text", () => {
  const secret = "reply mentioning user@example.com";
  const clean = interpretClaudeUsageProbe({ stdout: jsonl({ type: "assistant" }, { type: "result", is_error: false, result: secret }), exitCode: 0 }, SUBSCRIPTION, NOW);
  assert.deepEqual(clean, { kind: "error", error: "parse", probed: true });
  const failed = interpretClaudeUsageProbe({ stdout: `garbage\n${jsonl({ type: "result", is_error: true, result: "overloaded" })}`, exitCode: 1 }, SUBSCRIPTION, NOW);
  assert.deepEqual(failed, { kind: "error", error: "unknown", probed: true });
  assert.ok(!JSON.stringify([clean, failed]).includes("example.com"));
});

test("a probe that times out is a network error", async () => {
  const { deps } = recordingDeps(SUBSCRIPTION);
  deps.runProbe = () => Promise.reject(new ProbeTimeoutError());
  assert.deepEqual(await probeClaudeUsage(undefined, deps), { kind: "error", error: "network", probed: true });
});
