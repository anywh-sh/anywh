// The host's Codex skeleton against a fake `codex app-server`
// (tests/fixtures/fake-codex-app-server.mjs). Nothing here ran against a real
// Codex: these tests pin the life cycle (one app-server per host, one thread
// per agent, turns, interrupt, stop, restore), not Codex's behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexRuntimeDef } from "../runtimes/defs/codex.js";
import type { AgentRuntimeDef } from "../runtimes/types.js";
import { AgentHost, type AgentHostOptions } from "./agentHost.js";
import { HostClient, START_OF_LOG } from "./hostClient.js";
import type { AgentActivity, EventMessage } from "./protocol.js";

const FAKE_CODEX = resolve(import.meta.dirname, "../../tests/fixtures/fake-codex-app-server.mjs");

async function waitFor(check: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fakeCodexDef(env: Record<string, string>): AgentRuntimeDef {
  return { ...codexRuntimeDef, identity: { ...codexRuntimeDef.identity, bin: FAKE_CODEX, env: { ...codexRuntimeDef.identity.env, set: { ...codexRuntimeDef.identity.env.set, ...env } } } };
}

async function start(
  dir: string,
  hostId: string,
  env: Record<string, string>,
  extra: Partial<Pick<AgentHostOptions, "maxAlivePerRoom" | "hibernation">> = {},
): Promise<{ host: AgentHost; client: HostClient }> {
  const host = await AgentHost.start({ hostId, dataDir: join(dir, "data"), socketPath: join(dir, "run", "h.sock"), codexDef: fakeCodexDef(env), drainGraceMs: 500, ...extra });
  const client = new HostClient({ socketPath: host.socketPath, reconnectMinMs: 10, reconnectMaxMs: 50 });
  client.start();
  await client.waitUntilConnected();
  return { host, client };
}

function watch(client: HostClient, agentId: string): EventMessage[] {
  const events: EventMessage[] = [];
  client.subscribe(agentId, START_OF_LOG, { onEvent: (event) => events.push(event) });
  return events;
}

function completed(events: EventMessage[]): EventMessage[] {
  return events.filter((event) => event.ev.type === "codex_notification" && event.ev.method === "turn/completed");
}

async function activity(client: HostClient, agentId: string): Promise<AgentActivity> {
  const { agents } = await client.request<{ agents: AgentActivity[] }>("activity");
  return agents.find((agent) => agent.agentId === agentId)!;
}

test("Codex agents share one app-server, each on its own thread, with turns, interrupt and a declined approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-codexhost-"));
  const responses = join(dir, "responses.jsonl");
  const envFile = join(dir, "env.json");
  const hostId = `codex-test-${process.pid}`;
  const { host, client } = await start(dir, hostId, { FAKE_CODEX_RESPONSES: responses, FAKE_CODEX_ENV_FILE: envFile });
  try {
    const a = await client.request<AgentActivity>("spawn", { agentId: "c1", runtime: "codex", roomId: "r", spec: { cwd: dir }, message: "hello" });
    const b = await client.request<AgentActivity>("spawn", { agentId: "c2", runtime: "codex", roomId: "r", spec: { cwd: dir } });
    assert.equal(a.runtime, "codex");
    assert.notEqual(a.sessionId, b.sessionId, "one thread per agent");
    const env = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
    assert.match(env.ANYWH_AGENT_MARK, new RegExp(`^${hostId}:codex-app-server:[0-9a-f]+$`), "the shared app-server carries the host's mark");

    const c1 = watch(client, "c1");
    await waitFor(() => completed(c1).length === 1, 5000, "c1 turn");
    assert.ok(c1.some((event) => event.ev.method === "item/completed"));
    assert.equal((await activity(client, "c1")).state, "idle");

    const c2 = watch(client, "c2");
    await client.request("send", { agentId: "c2", message: "[[hang]]" });
    await waitFor(() => c2.some((event) => event.ev.method === "turn/started"), 5000, "c2 turn started");
    assert.equal((await activity(client, "c2")).state, "working");
    await assert.rejects(client.request("send", { agentId: "c2", message: "more" }), /between turns/);
    assert.deepEqual(await client.request("interrupt", { agentId: "c2" }), { interrupted: true });
    await waitFor(() => completed(c2).length === 1, 5000, "c2 interrupted");
    assert.equal((completed(c2)[0].ev.params as { turn: { status: string } }).turn.status, "interrupted");

    await client.request("send", { agentId: "c1", message: "[[approval]]" });
    await waitFor(() => completed(c1).length === 2, 5000, "approval turn");
    assert.deepEqual(JSON.parse(readFileSync(responses, "utf8").trim()), { decision: "cancel" });
    assert.ok(c1.some((event) => event.ev.type === "host_codex_request_declined"));

    // Idle: nothing to end (the process is shared), but it frees its slot.
    assert.equal((await client.request<AgentActivity>("hibernate", { agentId: "c1" })).state, "hibernated");
    assert.equal((await client.request<AgentActivity>("stop", { agentId: "c1" })).state, "stopped");
  } finally {
    client.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restarted host brings Codex agents back by thread id and runs the next turn on the same thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-codexhost-"));
  const hostId = `codex-restore-${process.pid}`;
  let first: Awaited<ReturnType<typeof start>> | undefined = await start(dir, hostId, {});
  let second: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const spawned = await first.client.request<AgentActivity>("spawn", { agentId: "c1", runtime: "codex", spec: { cwd: dir }, message: "one" });
    const events = watch(first.client, "c1");
    await waitFor(() => completed(events).length === 1, 5000, "first turn");
    first.client.close();
    await first.host.close();
    first = undefined;

    second = await start(dir, hostId, {});
    const restored = await activity(second.client, "c1");
    assert.equal(restored.state, "hibernated", "idle at shutdown");
    assert.equal(restored.sessionId, spawned.sessionId);
    assert.deepEqual(await second.client.request("send", { agentId: "c1", message: "two" }), { duringTurn: false, resumed: true });
    const after = watch(second.client, "c1");
    await waitFor(() => completed(after).length === 2, 5000, "second turn");
    const lastStart = after.filter((event) => event.ev.method === "turn/started").at(-1)!;
    assert.equal((lastStart.ev.params as { threadId: string }).threadId, spawned.sessionId);
    assert.ok(existsSync(join(dir, "data", "registry.json")));
  } finally {
    first?.client.close();
    if (first) await first.host.close();
    second?.client.close();
    if (second) await second.host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two messages racing to a Codex agent between turns start exactly one turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-codexhost-"));
  const { host, client } = await start(dir, `codex-race-${process.pid}`, {});
  try {
    await client.request("spawn", { agentId: "c1", runtime: "codex", spec: { cwd: dir } });
    const outcomes = await Promise.allSettled([
      client.request("send", { agentId: "c1", message: "[[hang]] one" }),
      client.request("send", { agentId: "c1", message: "[[hang]] two" }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.match(String((outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason), /between turns/);
    const events = watch(client, "c1");
    await waitFor(() => events.some((event) => event.ev.method === "turn/started"), 5000, "turn started");
    assert.equal(events.filter((event) => event.ev.type === "host_user_message").length, 1);
    await client.request("interrupt", { agentId: "c1" });
  } finally {
    client.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idle Codex agents give up their room slot, and an app-server exit leaves the idle ones hibernated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-codexhost-"));
  const { host, client } = await start(dir, `codex-room-${process.pid}`, {}, { maxAlivePerRoom: 2 });
  try {
    for (const agentId of ["c1", "c2"]) {
      await client.request("spawn", { agentId, runtime: "codex", roomId: "r", spec: { cwd: dir }, message: "hi" });
      const events = watch(client, agentId);
      await waitFor(() => completed(events).length === 1, 5000, `${agentId} turn`);
    }
    // A full room of idle Codex agents makes room like any other.
    await client.request("spawn", { agentId: "c3", runtime: "codex", roomId: "r", spec: { cwd: dir } });
    assert.equal((await activity(client, "c1")).state, "hibernated");

    // The shared app-server dies in c2's turn: c2 failed, idle c3 hibernated.
    await client.request("send", { agentId: "c2", message: "[[die]]" });
    await waitFor(() => host.activity().find((agent) => agent.agentId === "c2")?.state === "failed", 5000, "c2 failed");
    assert.equal((await activity(client, "c3")).state, "hibernated");

    // And a hibernated one resumes on a fresh app-server, same thread.
    const c1 = await activity(client, "c1");
    assert.deepEqual(await client.request("send", { agentId: "c1", message: "again" }), { duringTurn: false, resumed: true });
    const events = watch(client, "c1");
    await waitFor(() => completed(events).length === 2, 5000, "c1 resumed");
    assert.equal((await activity(client, "c1")).sessionId, c1.sessionId);
  } finally {
    client.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory pressure never picks a Codex agent: it has no memory of its own to free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-codexhost-"));
  const { host, client } = await start(dir, `codex-mem-${process.pid}`, {}, { hibernation: { policy: "memory", memoryBytes: 1, memoryFraction: 0.6 } });
  try {
    await client.request("spawn", { agentId: "c1", runtime: "codex", spec: { cwd: dir }, message: "hi" });
    const events = watch(client, "c1");
    await waitFor(() => completed(events).length === 1, 5000, "turn");
    assert.deepEqual(await host.runHibernationPolicy(), []);
    assert.equal((await activity(client, "c1")).state, "idle");
  } finally {
    client.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a room's Codex principal gets the room's settings again on a new app-server, and none of the user's MCP tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-codexhost-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.figma]\ncommand = "figma-mcp"\n\n[mcp_servers.linear]\nurl = "https://example.invalid/mcp"\n');
  const requests = join(dir, "requests.jsonl");
  const host = await AgentHost.start({
    hostId: `codex-resume-${process.pid}`,
    dataDir: join(dir, "data"),
    socketPath: join(dir, "run", "h.sock"),
    homeOverride: home,
    codexDef: fakeCodexDef({ FAKE_CODEX_REQUESTS: requests }),
    drainGraceMs: 500,
  });
  const client = new HostClient({ socketPath: host.socketPath, reconnectMinMs: 10, reconnectMaxMs: 50 });
  client.start();
  await client.waitUntilConnected();
  const room = { role: "principal", instructions: "only delegate", tools: [{ name: "delegate", description: "d", inputSchema: { type: "object" } }], bridgeUrl: "http://127.0.0.1:9/room/p/t" };
  const sent = (): { method: string; params: Record<string, unknown> }[] =>
    readFileSync(requests, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  try {
    await client.request("spawn", { agentId: "p1", runtime: "codex", roomId: "p1", spec: { cwd: dir, room }, message: "hello" });
    const events = watch(client, "p1");
    await waitFor(() => completed(events).length === 1, 5000, "first turn");
    const start = sent().find((request) => request.method === "thread/start")!;
    assert.deepEqual(start.params.config, {
      features: { multi_agent: false },
      web_search: "disabled",
      mcp_servers: { figma: { enabled_tools: [] }, linear: { enabled_tools: [] } },
    });

    await client.request("send", { agentId: "p1", message: "[[die]]" });
    await waitFor(() => host.activity().find((agent) => agent.agentId === "p1")?.state === "failed", 5000, "app-server died");
    await client.request("send", { agentId: "p1", message: "again" });
    await waitFor(() => completed(events).length === 2, 5000, "turn on the new app-server");
    const resume = sent().find((request) => request.method === "thread/resume");
    assert.ok(resume, "the thread was resumed on the new app-server before its turn");
    assert.equal(resume.params.threadId, start.params.threadId ?? (await activity(client, "p1")).sessionId);
    assert.deepEqual(resume.params.config, start.params.config, "the principal's settings are given again");
    assert.equal(resume.params.developerInstructions, "only delegate");
  } finally {
    client.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Stop sent before Codex has named the turn still interrupts it once it has", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-codexhost-"));
  const { host, client } = await start(dir, `codex-slow-${process.pid}`, {});
  try {
    await client.request("spawn", { agentId: "s1", runtime: "codex", spec: { cwd: dir }, message: "warm" });
    const events = watch(client, "s1");
    await waitFor(() => completed(events).length === 1, 5000, "first turn");
    const sending = client.request("send", { agentId: "s1", message: "work [[slow-start]]" });
    await waitFor(() => host.activity().find((agent) => agent.agentId === "s1")?.state === "working", 5000, "turn in flight");
    assert.deepEqual(await client.request("interrupt", { agentId: "s1" }), { interrupted: true });
    await sending;
    await waitFor(() => completed(events).length === 2, 5000, "the turn ended");
    assert.equal((completed(events)[1].ev.params as { turn: { status: string } }).turn.status, "interrupted");
  } finally {
    client.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
