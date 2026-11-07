// The sign-in queue against drivers written here (each sign-in a promise the
// test settles) and timers fired by hand. Pure — no process, no clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpAuthEngine, checkCallback, stateOfUrl, type AuthDriver, type AuthSession, type AuthStartMode } from "./engine.js";
import { parseAuthenticateReply } from "./claude.js";
import { isInvalidRedirect, localDelivery } from "./codex.js";
import { nameToAdd } from "../add.js";
import type { McpAuthFlow, McpInventoryEntry, McpRuntimeId } from "../types.js";

const entry = (runtimeId: McpRuntimeId, name: string, authMode: McpInventoryEntry["authMode"] = "oauth"): McpInventoryEntry => ({
  runtimeId,
  name,
  scope: authMode === "claudeai" ? "claudeai" : "user",
  transport: { type: authMode === "claudeai" ? "claudeai-proxy" : "http", url: "https://mcp.atlassian.com/v1/mcp" },
  status: "needs_auth",
  authMode,
  scannedAt: 0,
});

interface Started {
  readonly name: string;
  readonly mode: AuthStartMode;
  closed: boolean;
  completions: string[];
  settle?: (error?: Error) => void;
  signedIn: boolean;
}

/** A driver whose sign-ins answer at once, complete when the test says, and
 * remember what was asked. */
function driver(options: { claudeai?: boolean; fail?: string } = {}) {
  const started: Started[] = [];
  const instance: AuthDriver & { started: Started[] } = {
    started,
    begin(server, mode) {
      if (options.fail) return Promise.reject(new Error(options.fail));
      const record: Started = { name: server.name, mode, closed: false, completions: [], signedIn: false };
      started.push(record);
      const session: AuthSession = options.claudeai
        ? { authUrl: "https://claude.ai/api/organizations/o/mcp/start-auth/x", mode: "claudeai", recheck: () => Promise.resolve(record.signedIn), close: () => (record.closed = true) }
        : {
            authUrl: `https://auth.example.test/authorize?state=st-${server.name}`,
            mode,
            state: `st-${server.name}`,
            complete: (callbackUrl) => {
              record.completions.push(callbackUrl);
              return new Promise((resolve, reject) => (record.settle = (error) => (error ? reject(error) : resolve())));
            },
            close: () => (record.closed = true),
          };
      return Promise.resolve(session);
    },
  };
  return instance;
}

function harness(drivers: Partial<Record<McpRuntimeId, AuthDriver>>, servers: McpInventoryEntry[]) {
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const flows: McpAuthFlow[] = [];
  const signedIn: string[] = [];
  let ids = 0;
  let now = 0;
  const engine = new McpAuthEngine({
    drivers,
    entryOf: (target) => servers.find((server) => server.runtimeId === target.runtimeId && server.name === target.serverName),
    onSignedIn: (server) => signedIn.push(`${server.runtimeId}/${server.name}`),
    timeoutMs: 1000,
    recheckIntervalMs: 10,
    recheckWindowMs: 25,
    newId: () => `flow-${++ids}`,
    now: () => now,
    timers: {
      set: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clear: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
  });
  engine.subscribe((flow) => flows.push(flow));
  return {
    engine,
    signedIn,
    flows,
    latest: (flowId: string) => engine.flows().find((flow) => flow.flowId === flowId),
    /** Fires the oldest live timer of `ms`, moving the clock that far. */
    fire(ms: number) {
      const timer = timers.find((candidate) => !candidate.cleared && candidate.ms === ms);
      assert.ok(timer, `a timer of ${ms} ms is armed`);
      timer.cleared = true;
      now += ms;
      timer.callback();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const CLAUDE = entry("claude", "atlassian");
const CODEX = entry("codex", "atlassian");

test("targets are signed in one after the other, each waiting for its own callback", async () => {
  const claude = driver();
  const codex = driver();
  const h = harness({ claude, codex }, [CLAUDE, CODEX]);
  const [first, second] = h.engine.start([
    { runtimeId: "claude", serverName: "atlassian" },
    { runtimeId: "codex", serverName: "atlassian" },
  ]);
  await settle();
  assert.deepEqual(h.latest(first.flowId), { flowId: "flow-1", runtimeId: "claude", serverName: "atlassian", phase: "awaiting_user", mode: "deeplink", authUrl: "https://auth.example.test/authorize?state=st-atlassian", state: "st-atlassian" });
  assert.equal(h.latest(second.flowId)?.phase, "queued", "one sign-in at a time");
  assert.equal(codex.started.length, 0);

  assert.equal(h.engine.complete(first.flowId, "anywh://mcp-oauth/callback?code=c1&state=st-atlassian"), "ok");
  assert.equal(h.latest(first.flowId)?.phase, "completing");
  claude.started[0].settle?.();
  await settle();
  assert.equal(h.latest(first.flowId)?.phase, "done");
  assert.ok(claude.started[0].closed, "the sign-in's process is let go");
  assert.deepEqual(h.signedIn, ["claude/atlassian"]);
  assert.equal(h.latest(second.flowId)?.phase, "awaiting_user", "the next one starts");
  assert.equal(codex.started.length, 1);
});

test("a callback of another sign-in is refused and the flow keeps waiting; the right one completes it", async () => {
  const claude = driver();
  const h = harness({ claude }, [CLAUDE]);
  const [flow] = h.engine.start([{ runtimeId: "claude", serverName: "atlassian" }]);
  await settle();
  assert.equal(h.engine.complete(flow.flowId, "anywh://mcp-oauth/callback?code=c1&state=someone-else"), "state_mismatch");
  assert.equal(h.engine.complete(flow.flowId, "anywh://mcp-oauth/callback?state=st-atlassian"), "missing_code");
  assert.equal(h.engine.complete(flow.flowId, "not a url"), "not_url");
  assert.deepEqual(claude.started[0].completions, [], "nothing reached the CLI");
  assert.equal(h.latest(flow.flowId)?.phase, "awaiting_user");
  assert.equal(h.latest(flow.flowId)?.error, "not_url");
  assert.equal(h.engine.complete(flow.flowId, " anywh://mcp-oauth/callback?code=c1&state=st-atlassian "), "ok");
  assert.equal(h.latest(flow.flowId)?.error, undefined);
  assert.deepEqual(claude.started[0].completions, ["anywh://mcp-oauth/callback?code=c1&state=st-atlassian"]);
});

test("nobody finishing in time fails the flow, ends its sign-in and starts the next", async () => {
  const claude = driver();
  const codex = driver();
  const h = harness({ claude, codex }, [CLAUDE, CODEX]);
  const [first, second] = h.engine.start([
    { runtimeId: "claude", serverName: "atlassian" },
    { runtimeId: "codex", serverName: "atlassian" },
  ]);
  await settle();
  h.fire(1000);
  assert.deepEqual([h.latest(first.flowId)?.phase, h.latest(first.flowId)?.error], ["failed", "timeout"]);
  assert.ok(claude.started[0].closed);
  await settle();
  assert.equal(h.latest(second.flowId)?.phase, "awaiting_user");
  assert.equal(h.engine.complete(first.flowId, "anywh://mcp-oauth/callback?code=c&state=st-atlassian"), "not_waiting", "a late callback changes nothing");
  assert.deepEqual(h.signedIn, []);
});

test("the provider's error, the CLI's refusal and an unknown server each fail the flow", async () => {
  const claude = driver();
  const h = harness({ claude, codex: driver({ fail: "Address in use (os error 98)" }) }, [CLAUDE, CODEX]);
  const [denied] = h.engine.start([{ runtimeId: "claude", serverName: "atlassian" }]);
  await settle();
  h.engine.complete(denied.flowId, "anywh://mcp-oauth/callback?error=access_denied&state=st-atlassian");
  assert.deepEqual([h.latest(denied.flowId)?.phase, h.latest(denied.flowId)?.error], ["failed", "access_denied"]);

  const [refused] = h.engine.start([{ runtimeId: "claude", serverName: "atlassian" }]);
  await settle();
  h.engine.complete(refused.flowId, "anywh://mcp-oauth/callback?code=c&state=st-atlassian");
  claude.started[1].settle?.(new Error("Callback URL not accepted"));
  await settle();
  assert.deepEqual([h.latest(refused.flowId)?.phase, h.latest(refused.flowId)?.error], ["failed", "Callback URL not accepted"]);

  const [busy, unknown] = h.engine.start([
    { runtimeId: "codex", serverName: "atlassian" },
    { runtimeId: "codex", serverName: "nobody" },
  ]);
  await settle();
  assert.deepEqual([h.latest(busy.flowId)?.phase, h.latest(busy.flowId)?.error], ["failed", "Address in use (os error 98)"]);
  assert.deepEqual([h.latest(unknown.flowId)?.phase, h.latest(unknown.flowId)?.error], ["failed", "unknown_server"]);
});

test("cancelling a waiting flow ends its sign-in; a queued one never starts", async () => {
  const claude = driver();
  const codex = driver();
  const h = harness({ claude, codex }, [CLAUDE, CODEX]);
  const [first, second] = h.engine.start([
    { runtimeId: "claude", serverName: "atlassian" },
    { runtimeId: "codex", serverName: "atlassian" },
  ]);
  await settle();
  assert.ok(h.engine.cancel(second.flowId));
  assert.ok(h.engine.cancel(first.flowId));
  await settle();
  assert.deepEqual([h.latest(first.flowId)?.phase, h.latest(second.flowId)?.phase], ["cancelled", "cancelled"]);
  assert.ok(claude.started[0].closed);
  assert.equal(codex.started.length, 0);
  assert.equal(h.engine.cancel(first.flowId), false, "already over");
});

test("asking again for a target already on its way keeps its flow; asking for another device starts over on loopback", async () => {
  const claude = driver();
  const h = harness({ claude }, [CLAUDE]);
  const [first] = h.engine.start([{ runtimeId: "claude", serverName: "atlassian" }]);
  const [again] = h.engine.start([{ runtimeId: "claude", serverName: "atlassian" }]);
  assert.equal(again.flowId, first.flowId);
  await settle();
  h.engine.cancel(first.flowId);
  const [other] = h.engine.start([{ runtimeId: "claude", serverName: "atlassian" }], "localhost");
  await settle();
  assert.notEqual(other.flowId, first.flowId);
  assert.deepEqual(claude.started.map((started) => started.mode), ["deeplink", "localhost"]);
});

test("a claude.ai connector is looked at again until it is authorized, then the flow is done", async () => {
  const claudeai = driver({ claudeai: true });
  const connector = entry("claude", "claude.ai Atlassian", "claudeai");
  const h = harness({ claude: claudeai }, [connector]);
  const [flow] = h.engine.start([{ runtimeId: "claude", serverName: "claude.ai Atlassian" }]);
  await settle();
  assert.equal(h.latest(flow.flowId)?.mode, "claudeai");
  assert.equal(h.latest(flow.flowId)?.state, undefined, "no callback comes back to the app");
  assert.equal(h.engine.complete(flow.flowId, "anywh://mcp-oauth/callback?code=c"), "not_waiting");
  assert.ok(h.engine.recheck(flow.flowId));
  await settle();
  h.fire(10);
  await settle();
  h.fire(10);
  await settle();
  assert.deepEqual([h.latest(flow.flowId)?.phase, h.latest(flow.flowId)?.error], ["awaiting_user", "not_authorized"], "not yet, after the window");
  claudeai.started[0].signedIn = true;
  assert.ok(h.engine.recheck(flow.flowId));
  await settle();
  assert.equal(h.latest(flow.flowId)?.phase, "done");
  assert.deepEqual(h.signedIn, ["claude/claude.ai Atlassian"]);
});

test("a server that signs in with no OAuth is not offered a sign-in", async () => {
  const h = harness({ claude: driver() }, [entry("claude", "local", "none")]);
  const [flow] = h.engine.start([{ runtimeId: "claude", serverName: "local" }]);
  await settle();
  assert.deepEqual([h.latest(flow.flowId)?.phase, h.latest(flow.flowId)?.error], ["failed", "unsupported"]);
});

test("callbacks are checked for a code and the flow's state", () => {
  assert.equal(stateOfUrl("https://auth.example.test/authorize?redirect_uri=x&state=abc"), "abc");
  assert.equal(stateOfUrl("nope"), undefined);
  assert.equal(checkCallback("http://127.0.0.1:5/callback/x?code=1&state=abc", "abc"), "ok");
  assert.equal(checkCallback("http://127.0.0.1:5/callback/x?error=access_denied&state=abc", "abc"), "ok");
  assert.equal(checkCallback("http://127.0.0.1:5/callback/x?code=1", "abc"), "state_mismatch");
  assert.equal(checkCallback("http://127.0.0.1:5/callback/x?code=1", undefined), "ok");
});

test("Claude's sign-in answer: the app's link, loopback, or claude.ai", () => {
  assert.deepEqual(parseAuthenticateReply({ authUrl: "https://a/authorize?state=s1", requiresUserAction: true, callbackExpected: true, redirectScheme: "custom", state: "s1" }), { authUrl: "https://a/authorize?state=s1", mode: "deeplink", state: "s1" });
  assert.deepEqual(parseAuthenticateReply({ authUrl: "https://a/authorize?state=s2", callbackExpected: true, redirectScheme: "localhost", callbackPort: 62206 }), { authUrl: "https://a/authorize?state=s2", mode: "localhost", state: "s2" });
  assert.deepEqual(parseAuthenticateReply({ authUrl: "https://claude.ai/api/organizations/o/mcp/start-auth/m", requiresUserAction: true, callbackExpected: false }), { authUrl: "https://claude.ai/api/organizations/o/mcp/start-auth/m", mode: "claudeai" });
  assert.equal(parseAuthenticateReply({ requiresUserAction: true }), undefined);
});

test("Codex's callbacks are delivered to its listener by path, whatever their scheme", () => {
  assert.equal(localDelivery("anywh://mcp-oauth/callback/iCyMXEcxWEkb?code=c&state=s", 51270), "http://127.0.0.1:51270/callback/iCyMXEcxWEkb?code=c&state=s");
  assert.equal(localDelivery("http://127.0.0.1:51270/callback/x?code=c&state=s", 51270), "http://127.0.0.1:51270/callback/x?code=c&state=s");
  assert.equal(localDelivery("not a url", 1), undefined);
  assert.ok(isInvalidRedirect("failed to login to MCP server 'atlassian': dynamic client registration failed: invalid_redirect_uri"));
  assert.ok(!isInvalidRedirect("Address in use (os error 98)"));
});

test("a server is added under the provider's name unless the CLI has one by that name", () => {
  assert.equal(nameToAdd("jira", ["sentry"]), "atlassian");
  assert.equal(nameToAdd("jira", ["atlassian"]), "atlassian-anywh");
  assert.equal(nameToAdd("jira", ["atlassian", "atlassian-anywh"]), undefined);
  assert.equal(nameToAdd("linear", []), undefined);
});
