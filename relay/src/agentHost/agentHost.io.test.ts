// The agent host with real `claude` stand-ins: the fake CLI from
// tests/fixtures (the one sanctioned mock boundary) in its persistent
// stream-json mode, real child processes, a real socket and real logs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost, type AgentHostOptions } from "./agentHost.js";
import { HostClient, START_OF_LOG } from "./hostClient.js";
import { isAlive } from "./processTree.js";
import type { AgentActivity, EventMessage } from "./protocol.js";

const FAKE_CLAUDE = resolve(import.meta.dirname, "../../tests/fixtures/fake-claude.mjs");

async function waitFor(check: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Harness {
  dir: string;
  home: string;
  hostId: string;
  host: AgentHost;
  client: HostClient;
  events: Map<string, EventMessage[]>;
  watch(agentId: string): EventMessage[];
  activity(agentId: string): Promise<AgentActivity>;
  file(name: string): string;
  cleanup(): Promise<void>;
}

type HostOverrides = Partial<Omit<AgentHostOptions, "hostId" | "dataDir" | "socketPath">>;

async function harness(options: HostOverrides & { reuse?: { dir: string; hostId: string } } = {}): Promise<Harness> {
  const dir = options.reuse?.dir ?? mkdtempSync(join(tmpdir(), "anywh-agenthost-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const hostId = options.reuse?.hostId ?? `test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const host = await AgentHost.start({
    hostId,
    dataDir: join(dir, "data"),
    socketPath: join(dir, "run", "host.sock"),
    agentBin: FAKE_CLAUDE,
    homeOverride: home,
    stopGraceMs: 3000,
    drainGraceMs: 2000,
    turnSettleMs: 300,
    ...options,
  });
  const client = new HostClient({ socketPath: host.socketPath, reconnectMinMs: 10, reconnectMaxMs: 50 });
  client.start();
  await client.waitUntilConnected();
  const events = new Map<string, EventMessage[]>();
  const h: Harness = {
    dir,
    home,
    hostId,
    host,
    client,
    events,
    watch(agentId) {
      const list: EventMessage[] = [];
      events.set(agentId, list);
      client.subscribe(agentId, START_OF_LOG, { onEvent: (event) => list.push(event) });
      return list;
    },
    async activity(agentId) {
      const { agents } = await client.request<{ agents: AgentActivity[] }>("activity");
      const found = agents.find((agent) => agent.agentId === agentId);
      if (!found) throw new Error(`no agent ${agentId} in activity`);
      return found;
    },
    file(name) {
      return join(dir, name);
    },
    async cleanup() {
      client.close();
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

function results(events: EventMessage[]): EventMessage[] {
  return events.filter((event) => event.ev.type === "result");
}

function spec(h: Harness, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { cwd: h.dir, model: "haiku", ...extra };
}

test("a turn runs through the host: the CLI's events land in the log, the state follows the turn", async () => {
  const h = await harness();
  try {
    const argvFile = h.file("argv.jsonl");
    const envFile = h.file("env.jsonl");
    const mcpCopy = h.file("mcp-copy.json");
    await h.client.request("spawn", {
      agentId: "a1",
      roomId: "r1",
      spec: spec(h, {
        mcpConfigJson: JSON.stringify({ mcpServers: { "anywh-room": { type: "http", url: "http://127.0.0.1:1/room/x" } } }),
        // A billed credential smuggled in through the spec never reaches the child.
        env: { FAKE_CLAUDE_ARGV_FILE: argvFile, FAKE_CLAUDE_ENV_FILE: envFile, FAKE_CLAUDE_MCP_CONFIG_COPY: mcpCopy, ANTHROPIC_API_KEY: "sk-should-not-leak" },
      }),
      message: "hello",
    });
    const events = h.watch("a1");
    await waitFor(() => results(events).length === 1, 8000, "first result");
    const types = events.map((event) => event.ev.type);
    assert.deepEqual(types.slice(0, 2), ["host_process", "host_user_message"]);
    assert.ok(types.includes("system") && types.includes("stream_event") && types.includes("assistant"));
    assert.equal(results(events)[0].ev.result, "echo: hello");

    const state = await h.activity("a1");
    assert.equal(state.state, "idle");
    assert.equal(state.alive, true);
    assert.equal(state.roomId, "r1");
    assert.equal(state.sessionId, events.find((event) => event.ev.type === "system")?.ev.session_id);

    const argv = JSON.parse(readFileSync(argvFile, "utf8").trim()) as string[];
    for (const flag of ["--input-format", "--output-format", "--verbose", "--include-partial-messages"]) assert.ok(argv.includes(flag), flag);
    assert.equal(argv[argv.indexOf("--setting-sources") + 1], "project,local");
    assert.equal(argv[argv.indexOf("--model") + 1], "haiku");
    const copy = JSON.parse(readFileSync(mcpCopy, "utf8")) as { path: string; mode: number; content: string };
    assert.equal(copy.mode, 0o600);
    assert.ok((JSON.parse(copy.content) as { mcpServers: Record<string, unknown> }).mcpServers["anywh-room"]);

    const env = JSON.parse(readFileSync(envFile, "utf8").trim()) as Record<string, string>;
    assert.match(env.ANYWH_AGENT_MARK, new RegExp(`^${h.hostId}:a1:[0-9a-f]+$`));
    // The host's own configuration never reaches an agent.
    for (const name of ["ANYWH_AGENT_HOST_ID", "ANYWH_AGENT_HOST_SOCKET", "ANYWH_AGENT_HOST_DIR", "ANYWH_PROFILE"]) assert.equal(Object.keys(env).includes(name), false, name);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(env.HOME, h.home);
    assert.equal(Object.keys(env).includes("ANTHROPIC_API_KEY"), false);

    // The MCP config file lives as long as the process, no longer.
    assert.equal(existsSync(copy.path), true);
    await h.client.request("stop", { agentId: "a1" });
    await waitFor(() => !existsSync(copy.path), 3000, "MCP config removal");
  } finally {
    await h.cleanup();
  }
});

test("a message sent during a turn is acknowledged as such and folded into that same turn", async () => {
  const h = await harness();
  try {
    await h.client.request("spawn", { agentId: "a1", spec: spec(h) });
    const events = h.watch("a1");
    const gate = h.file("gate");
    assert.deepEqual(await h.client.request("send", { agentId: "a1", message: `build it [[gate:${gate}]]` }), { duringTurn: false, resumed: false });
    await waitFor(() => events.some((event) => event.ev.type === "assistant"), 5000, "turn output");
    assert.equal((await h.activity("a1")).state, "working");
    assert.deepEqual(await h.client.request("send", { agentId: "a1", message: "also update the docs" }), { duringTurn: true, resumed: false });
    writeFileSync(gate, "");
    await waitFor(() => results(events).length === 1 && events.at(-1)?.ev.type === "result", 5000, "result");
    assert.match(String(results(events)[0].ev.result), /absorbed: also update the docs/);
    const userMessages = events.filter((event) => event.ev.type === "host_user_message").map((event) => event.ev.duringTurn);
    assert.deepEqual(userMessages, [false, true]);
    // Idle once it is clear the second message started no turn of its own.
    await waitFor(() => h.host.activity()[0]?.state === "idle", 5000, "idle after the steered turn");
  } finally {
    await h.cleanup();
  }
});

test("interrupt ends the turn in flight and keeps the process for the next one", async () => {
  const h = await harness();
  try {
    await h.client.request("spawn", { agentId: "a1", spec: spec(h) });
    const events = h.watch("a1");
    assert.deepEqual(await h.client.request("interrupt", { agentId: "a1" }), { interrupted: false });
    await h.client.request("send", { agentId: "a1", message: "[[hang]]" });
    await waitFor(() => events.some((event) => event.ev.type === "assistant"), 5000, "tool call");
    const before = await h.activity("a1");
    assert.deepEqual(await h.client.request("interrupt", { agentId: "a1" }), { interrupted: true });
    await waitFor(() => results(events).length === 1, 5000, "interrupted result");
    assert.equal(results(events)[0].ev.is_error, true);
    assert.equal(results(events)[0].ev.terminal_reason, "aborted_tools");
    const after = await h.activity("a1");
    assert.equal(after.state, "idle");
    assert.equal(after.pid, before.pid);
    await h.client.request("send", { agentId: "a1", message: "still there?" });
    await waitFor(() => results(events).length === 2, 5000, "next turn");
    assert.equal(results(events)[1].ev.result, "echo: still there?");
  } finally {
    await h.cleanup();
  }
});

for (const variant of ["cooperative", "ignores SIGTERM"] as const) {
  test(`stopping an agent whose tools have children leaves no process alive (${variant})`, async () => {
    const h = await harness({ stopGraceMs: variant === "cooperative" ? 3000 : 300 });
    try {
      const pidFile = h.file("pids.json");
      const env = variant === "cooperative" ? {} : { FAKE_CLAUDE_IGNORE_SIGTERM: "1" };
      await h.client.request("spawn", { agentId: "a1", spec: spec(h, { env }), message: `run the dev server [[children:${pidFile}]]` });
      await waitFor(() => existsSync(pidFile), 5000, "children started");
      const { inGroup, ownSession } = JSON.parse(readFileSync(pidFile, "utf8")) as { inGroup: number; ownSession: number };
      const { pid } = await h.activity("a1");
      assert.ok(pid && isAlive(pid) && isAlive(inGroup) && isAlive(ownSession));

      const stopped = await h.client.request<AgentActivity>("stop", { agentId: "a1" });
      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.alive, false);
      await waitFor(() => !isAlive(pid) && !isAlive(inGroup) && !isAlive(ownSession), 5000, "every process gone");
    } finally {
      await h.cleanup();
    }
  });
}

test("a crashed agent is reported failed, and the next message resumes its session", async () => {
  const h = await harness();
  try {
    const argvFile = h.file("argv.jsonl");
    await h.client.request("spawn", { agentId: "a1", spec: spec(h, { env: { FAKE_CLAUDE_ARGV_FILE: argvFile } }), message: "first" });
    const events = h.watch("a1");
    await waitFor(() => results(events).length === 1, 5000, "first turn");
    const sessionId = (await h.activity("a1")).sessionId;
    await h.client.request("send", { agentId: "a1", message: "[[crash]]" });
    await waitFor(() => events.some((event) => event.ev.type === "host_process" && event.ev.subtype === "exited"), 5000, "exit");
    const failed = await h.activity("a1");
    assert.equal(failed.state, "failed");
    assert.match(failed.failure ?? "", /code 3/);
    assert.equal(failed.resumable, true);

    assert.deepEqual(await h.client.request("send", { agentId: "a1", message: "back?" }), { duringTurn: false, resumed: true });
    await waitFor(() => results(events).length === 2, 5000, "resumed turn");
    const lastArgv = JSON.parse(readFileSync(argvFile, "utf8").trim().split("\n").at(-1)!) as string[];
    assert.equal(lastArgv[lastArgv.indexOf("--resume") + 1], sessionId);
    assert.equal((await h.activity("a1")).sessionId, sessionId);
  } finally {
    await h.cleanup();
  }
});

test("on start the host ends processes a previous run of it left behind, and only those", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-orphans-"));
  const hostId = `orphan-test-${process.pid}`;
  const sleeper = (env: Record<string, string>) => spawn("sleep", ["300"], { detached: true, stdio: "ignore", env: { ...process.env, ...env } });
  // An agent (or one of its tools) of a previous run of this host.
  const orphan = sleeper({ ANYWH_AGENT_MARK: `${hostId}:gone:oldnonce` });
  // Another host's agent.
  const otherHost = sleeper({ ANYWH_AGENT_MARK: `${hostId}-other:a1:n` });
  // A process that merely carries the host's CONFIG (a relay or a session
  // started from the same env file) — never an agent.
  const configOnly = sleeper({ ANYWH_AGENT_HOST_ID: hostId, ANYWH_PROFILE: hostId });
  // A malformed mark with no agent id.
  const noAgent = sleeper({ ANYWH_AGENT_MARK: `${hostId}::n` });
  const unrelated = sleeper({});
  const all = [orphan, otherHost, configOnly, noAgent, unrelated];
  try {
    await waitFor(() => all.every((child) => child.pid !== undefined && isAlive(child.pid)), 3000, "sleepers");
    const host = await AgentHost.start({ hostId, dataDir: join(dir, "data"), socketPath: join(dir, "run", "h.sock"), agentBin: FAKE_CLAUDE });
    await host.close();
    // The orphan is this test's own child: it is gone once Node reaps it.
    await waitFor(() => !isAlive(orphan.pid!), 3000, "orphan reaped");
    for (const survivor of [otherHost, configOnly, noAgent, unrelated]) assert.equal(isAlive(survivor.pid!), true);
  } finally {
    for (const child of all) if (child.pid && isAlive(child.pid)) process.kill(child.pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove ends the agent, deletes its log and forgets it", async () => {
  const h = await harness();
  try {
    await h.client.request("spawn", { agentId: "a1", spec: spec(h), message: "hi" });
    const events = h.watch("a1");
    await waitFor(() => results(events).length === 1, 5000, "turn");
    const { pid } = await h.activity("a1");
    assert.deepEqual(await h.client.request("remove", { agentId: "a1" }), { removed: true });
    assert.equal(isAlive(pid!), false);
    assert.equal(existsSync(join(h.dir, "data", "logs", "a1")), false);
    const { agents } = await h.client.request<{ agents: AgentActivity[] }>("activity");
    assert.deepEqual(agents, []);
    await assert.rejects(h.client.request("send", { agentId: "a1", message: "x" }), /no agent a1/);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------- hibernation, cap, drain, restore

function lastArgv(file: string): string[] {
  return JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!) as string[];
}

test("an idle agent is hibernated after the idle time and its next message resumes the same session", async () => {
  let clock = 1_000_000;
  const h = await harness({ now: () => clock, hibernation: { policy: "idle", idleMs: 600_000 } });
  try {
    const argvFile = h.file("argv.jsonl");
    await h.client.request("spawn", { agentId: "a1", spec: spec(h, { env: { FAKE_CLAUDE_ARGV_FILE: argvFile } }), message: "remember 42" });
    const events = h.watch("a1");
    await waitFor(() => results(events).length === 1, 5000, "first turn");
    const { pid, sessionId } = await h.activity("a1");
    assert.deepEqual(await h.host.runHibernationPolicy(), []);

    clock += 600_001;
    assert.deepEqual(await h.host.runHibernationPolicy(), ["a1"]);
    const hibernated = await h.activity("a1");
    assert.equal(hibernated.state, "hibernated");
    assert.equal(hibernated.alive, false);
    assert.equal(hibernated.resumable, true);
    assert.equal(isAlive(pid!), false);

    assert.deepEqual(await h.client.request("send", { agentId: "a1", message: "what was it?" }), { duringTurn: false, resumed: true });
    await waitFor(() => results(events).length === 2, 5000, "resumed turn");
    assert.equal(lastArgv(argvFile)[lastArgv(argvFile).indexOf("--resume") + 1], sessionId);
    const resumed = await h.activity("a1");
    assert.equal(resumed.state, "idle");
    assert.equal(resumed.sessionId, sessionId);
  } finally {
    await h.cleanup();
  }
});

test("an agent with a turn in flight or a background task still running is never hibernated", async () => {
  let clock = 1_000_000;
  const h = await harness({ now: () => clock, hibernation: { policy: "idle", idleMs: 1000 } });
  try {
    const gate = h.file("gate");
    const bgGate = h.file("bg-gate");
    await h.client.request("spawn", { agentId: "busy", spec: spec(h), message: `[[gate:${gate}]]` });
    await h.client.request("spawn", { agentId: "bg", spec: spec(h), message: `[[bg-task:${bgGate}]]` });
    const busy = h.watch("busy");
    const bg = h.watch("bg");
    await waitFor(() => busy.some((event) => event.ev.type === "assistant") && results(bg).length === 1, 5000, "both agents going");
    assert.equal((await h.activity("bg")).backgroundTasks, 1);

    clock += 3_600_000;
    assert.deepEqual(await h.host.runHibernationPolicy(), []);
    await assert.rejects(h.client.request("hibernate", { agentId: "busy" }), /a turn is in flight/);
    await assert.rejects(h.client.request("hibernate", { agentId: "bg" }), /background tasks/);

    writeFileSync(gate, "");
    writeFileSync(bgGate, "");
    await waitFor(() => results(busy).length === 1, 5000, "busy turn over");
    await waitFor(() => bg.some((event) => event.ev.type === "system" && event.ev.subtype === "task_notification"), 5000, "bg task over");
    await waitFor(() => (h.host.activity().find((agent) => agent.agentId === "bg")?.backgroundTasks ?? 1) === 0, 5000, "bg count");
    clock += 3_600_000;
    assert.deepEqual((await h.host.runHibernationPolicy()).sort(), ["bg", "busy"]);
  } finally {
    await h.cleanup();
  }
});

test("waiting for the person is its own state, survives hibernation, and ends with the next message", async () => {
  const h = await harness();
  try {
    await h.client.request("spawn", { agentId: "a1", spec: spec(h), message: "ask me something" });
    const events = h.watch("a1");
    await waitFor(() => results(events).length === 1, 5000, "turn");
    assert.equal((await h.client.request<AgentActivity>("mark_awaiting", { agentId: "a1", awaiting: true })).state, "awaiting_user");
    const hibernated = await h.client.request<AgentActivity>("hibernate", { agentId: "a1" });
    assert.equal(hibernated.state, "awaiting_user");
    assert.equal(hibernated.alive, false);
    await h.client.request("send", { agentId: "a1", message: "blue" });
    await waitFor(() => results(events).length === 2, 5000, "answer turn");
    const after = await h.activity("a1");
    assert.equal(after.awaitingUser, false);
    assert.equal(after.state, "idle");
  } finally {
    await h.cleanup();
  }
});

test("a full room hibernates its oldest idle agent to start another, and refuses when none is idle", async () => {
  let clock = 1_000_000;
  const h = await harness({ now: () => clock, maxAlivePerRoom: 2 });
  try {
    for (const agentId of ["a1", "a2"]) {
      await h.client.request("spawn", { agentId, roomId: "r", spec: spec(h), message: "hi" });
      const events = h.watch(agentId);
      await waitFor(() => results(events).length === 1, 5000, `${agentId} turn`);
      clock += 1000;
    }
    const a3 = await h.client.request<AgentActivity>("spawn", { agentId: "a3", roomId: "r", spec: spec(h) });
    assert.equal(a3.alive, true);
    assert.equal((await h.activity("a1")).state, "hibernated");
    assert.equal((await h.activity("a2")).alive, true);

    // Both live agents busy: nothing to make room with.
    const gate = h.file("gate");
    await h.client.request("send", { agentId: "a2", message: `[[gate:${gate}]]` });
    await h.client.request("send", { agentId: "a3", message: `[[gate:${gate}]]` });
    await assert.rejects(h.client.request("spawn", { agentId: "a4", roomId: "r", spec: spec(h) }), /room r already has 2 live agents/);
    await assert.rejects(h.client.request("send", { agentId: "a1", message: "wake up" }), /room r already has 2 live agents/);
    // Another room is not affected.
    assert.equal((await h.client.request<AgentActivity>("spawn", { agentId: "b1", roomId: "s", spec: spec(h) })).alive, true);
    writeFileSync(gate, "");
  } finally {
    await h.cleanup();
  }
});

test("the memory policy hibernates idle agents only while the agents use more than their share", async () => {
  const roomy = await harness({ hibernation: { policy: "memory", memoryBytes: 1e15, memoryFraction: 0.6 } });
  try {
    await roomy.client.request("spawn", { agentId: "a1", spec: spec(roomy), message: "hi" });
    const events = roomy.watch("a1");
    await waitFor(() => results(events).length === 1, 5000, "turn");
    assert.deepEqual(await roomy.host.runHibernationPolicy(), []);
  } finally {
    await roomy.cleanup();
  }
  const tight = await harness({ hibernation: { policy: "memory", memoryBytes: 1, memoryFraction: 0.6 } });
  try {
    const gate = tight.file("gate");
    await tight.client.request("spawn", { agentId: "idle1", spec: spec(tight), message: "hi" });
    await tight.client.request("spawn", { agentId: "busy", spec: spec(tight), message: `[[gate:${gate}]]` });
    const idle = tight.watch("idle1");
    const busy = tight.watch("busy");
    await waitFor(() => results(idle).length === 1 && busy.some((event) => event.ev.type === "assistant"), 5000, "agents going");
    const expected = process.platform === "linux" ? ["idle1"] : [];
    assert.deepEqual(await tight.host.runHibernationPolicy(), expected);
    assert.equal((await tight.activity("busy")).alive, true);
    writeFileSync(gate, "");
  } finally {
    await tight.cleanup();
  }
});

test("shutdown hibernates idle agents and stops the ones whose turn it had to cut; the next host restores both, running neither", async () => {
  const h = await harness({ drainGraceMs: 300 });
  const reuse = { dir: h.dir, hostId: h.hostId };
  let restarted: Harness | undefined;
  try {
    await h.client.request("spawn", { agentId: "idle1", spec: spec(h), message: "hi" });
    await h.client.request("spawn", { agentId: "busy", spec: spec(h), message: "[[hang]]" });
    const idle = h.watch("idle1");
    const busy = h.watch("busy");
    await waitFor(() => results(idle).length === 1 && busy.some((event) => event.ev.type === "assistant"), 5000, "agents going");
    const pids = h.host.activity().map((agent) => agent.pid!);
    const lastSeq = idle.at(-1)!.seq;

    h.client.close();
    await h.host.close();
    assert.ok(pids.every((pid) => !isAlive(pid)), "every agent process ended");

    restarted = await harness({ reuse });
    const idleState = await restarted.activity("idle1");
    assert.equal(idleState.state, "hibernated");
    assert.equal(idleState.alive, false);
    const busyState = await restarted.activity("busy");
    assert.equal(busyState.state, "stopped");
    assert.equal(busyState.stopReason, "host_shutdown");
    assert.equal(busyState.resumable, true);

    // The cut turn ended with the interrupt's own result before the stop.
    const busyEvents = restarted.watch("busy");
    await waitFor(() => busyEvents.some((event) => event.ev.type === "host_process" && event.ev.subtype === "exited"), 5000, "busy log");
    assert.equal(results(busyEvents).at(-1)?.ev.terminal_reason, "aborted_tools");

    const idleEvents = restarted.watch("idle1");
    assert.deepEqual(await restarted.client.request("send", { agentId: "idle1", message: "back" }), { duringTurn: false, resumed: true });
    await waitFor(() => results(idleEvents).length === 2, 5000, "resumed turn");
    // The log continued where it was, across hosts.
    const seqs = idleEvents.map((event) => event.seq);
    assert.deepEqual(
      seqs,
      Array.from({ length: seqs.length }, (_, i) => i),
    );
    assert.ok(seqs.length > lastSeq + 1);
  } finally {
    if (restarted) await restarted.cleanup();
    else await h.cleanup();
  }
});

// ---------------------------------------------------------------- exclusivity

test("a second host for the same profile fails before touching the first one's agents, registry or logs", async () => {
  const h = await harness();
  try {
    await h.client.request("spawn", { agentId: "a1", spec: spec(h), message: "hi" });
    const events = h.watch("a1");
    await waitFor(() => results(events).length === 1, 5000, "turn");
    const { pid, nextOffset } = await h.activity("a1");
    const registryPath = join(h.dir, "data", "registry.json");
    const registryBefore = readFileSync(registryPath, "utf8");

    const attempts = [
      // Same everything.
      { hostId: h.hostId, dataDir: join(h.dir, "data"), socketPath: join(h.dir, "run", "host.sock") },
      // Same host id (the marker its sweep matches), other paths.
      { hostId: h.hostId, dataDir: join(h.dir, "data2"), socketPath: join(h.dir, "run", "other.sock") },
      // Same data dir, other id and socket.
      { hostId: `${h.hostId}-x`, dataDir: join(h.dir, "data"), socketPath: join(h.dir, "run", "third.sock") },
    ];
    for (const paths of attempts) {
      await assert.rejects(AgentHost.start({ ...paths, agentBin: FAKE_CLAUDE, homeOverride: h.home }), /already/);
    }
    assert.equal(isAlive(pid!), true, "the first host's agent is untouched");
    assert.equal(readFileSync(registryPath, "utf8"), registryBefore);
    assert.equal((await h.activity("a1")).nextOffset, nextOffset, "no event appended to its log");
  } finally {
    await h.cleanup();
  }
});

test("two hosts starting at once on the same profile: exactly one wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-race-"));
  const options = { hostId: `race-${process.pid}`, dataDir: join(dir, "data"), socketPath: join(dir, "run", "h.sock"), agentBin: FAKE_CLAUDE };
  try {
    const outcomes = await Promise.allSettled([AgentHost.start(options), AgentHost.start(options), AgentHost.start(options)]);
    const winners = outcomes.filter((outcome): outcome is PromiseFulfilledResult<AgentHost> => outcome.status === "fulfilled");
    assert.equal(winners.length, 1);
    await winners[0].value.close();
    // Released on close: the profile can start again.
    const again = await AgentHost.start(options);
    await again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- log failures

test("a log that cannot be written fails only its own agent; the host and the other agents carry on", async () => {
  // Small segments, so the next events force a rotation into a directory
  // that has become read-only.
  const h = await harness({ log: { segmentBytes: 600 } });
  try {
    await h.client.request("spawn", { agentId: "ok1", spec: spec(h), message: "hi" });
    await h.client.request("spawn", { agentId: "bad", spec: spec(h), message: "hi" });
    const okEvents = h.watch("ok1");
    const badEvents = h.watch("bad");
    await waitFor(() => results(okEvents).length === 1 && results(badEvents).length === 1, 5000, "first turns");
    const { pid } = await h.activity("bad");
    chmodSync(join(h.dir, "data", "logs", "bad"), 0o500);
    try {
      await h.client.request("send", { agentId: "bad", message: "x".repeat(700) }).catch(() => {});
      await waitFor(() => h.host.activity().find((agent) => agent.agentId === "bad")?.state === "failed", 5000, "bad agent failed");
      const bad = await h.activity("bad");
      assert.match(bad.failure ?? "", /log_error/);
      await waitFor(() => !isAlive(pid!), 5000, "its process ended");
      await assert.rejects(h.client.request("send", { agentId: "bad", message: "again" }), /log/);
    } finally {
      chmodSync(join(h.dir, "data", "logs", "bad"), 0o700);
    }
    await h.client.request("send", { agentId: "ok1", message: "still fine?" });
    await waitFor(() => results(okEvents).length === 2, 5000, "other agent's turn");
  } finally {
    await h.cleanup();
  }
});

test("an agent whose log cannot be opened on restore comes back failed instead of failing the host's start", async () => {
  const h = await harness();
  const reuse = { dir: h.dir, hostId: h.hostId };
  let again: Harness | undefined;
  try {
    await h.client.request("spawn", { agentId: "a1", spec: spec(h), message: "hi" });
    await h.client.request("spawn", { agentId: "a2", spec: spec(h), message: "hi" });
    const events = h.watch("a1");
    await waitFor(() => results(events).length === 1, 5000, "turn");
    h.client.close();
    await h.host.close();
    // a2's log directory is replaced by something that is not a directory.
    rmSync(join(h.dir, "data", "logs", "a2"), { recursive: true, force: true });
    writeFileSync(join(h.dir, "data", "logs", "a2"), "not a directory");
    again = await harness({ reuse });
    assert.equal((await again.activity("a2")).state, "failed");
    assert.match((await again.activity("a2")).failure ?? "", /log_error/);
    assert.equal((await again.activity("a1")).state, "hibernated");
  } finally {
    if (again) await again.cleanup();
    else await h.cleanup();
  }
});

// ---------------------------------------------------------------- races inside an agent's queue

for (const order of ["remove first", "send first"] as const) {
  test(`remove racing a send that must start a process leaves no process behind (${order})`, async () => {
    const h = await harness();
    try {
      await h.client.request("spawn", { agentId: "a1", spec: spec(h), message: "hi" });
      const events = h.watch("a1");
      await waitFor(() => results(events).length === 1, 5000, "turn");
      await h.client.request("hibernate", { agentId: "a1" });
      let send: Promise<unknown>;
      let remove: Promise<unknown>;
      if (order === "remove first") {
        remove = h.client.request("remove", { agentId: "a1" });
        send = h.client.request("send", { agentId: "a1", message: "wake up" });
      } else {
        send = h.client.request("send", { agentId: "a1", message: "wake up" });
        remove = h.client.request("remove", { agentId: "a1" });
      }
      const [sent, removed] = await Promise.allSettled([send, remove]);
      assert.equal(removed.status, "fulfilled");
      if (order === "remove first") {
        // Nothing may start for an agent being removed.
        assert.equal(sent.status, "rejected");
        assert.match(String((sent).reason), /no agent a1/);
      }
      await waitFor(() => !h.host.activity().some((agent) => agent.agentId === "a1"), 5000, "forgotten");
      const { findAgentProcesses } = await import("./processTree.js");
      assert.deepEqual(await findAgentProcesses(h.hostId, "a1"), [], "no process of the removed agent");
      assert.deepEqual((await h.client.request<{ agents: AgentActivity[] }>("activity")).agents, []);
    } finally {
      await h.cleanup();
    }
  });
}

test("concurrent resumes in a full room never exceed its cap", async () => {
  let clock = 1_000_000;
  const h = await harness({ now: () => clock, maxAlivePerRoom: 3 });
  try {
    const ids = ["r1", "r2", "r3", "r4", "r5", "r6"];
    for (const agentId of ids) {
      await h.client.request("spawn", { agentId, roomId: "r", spec: spec(h), message: "hi" });
      const events = h.watch(agentId);
      await waitFor(() => results(events).length === 1, 5000, `${agentId} turn`);
      clock += 1000;
    }
    for (const agent of h.host.activity()) if (agent.alive) await h.client.request("hibernate", { agentId: agent.agentId });
    assert.equal(h.host.activity().filter((agent) => agent.alive).length, 0);

    const gate = h.file("gate");
    const outcomes = await Promise.allSettled(ids.map((agentId) => h.client.request("send", { agentId, message: `[[gate:${gate}]]` })));
    const alive = h.host.activity().filter((agent) => agent.alive).length;
    assert.ok(alive <= 3, `${alive} live agents in a room capped at 3`);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 3);
    for (const outcome of outcomes) if (outcome.status === "rejected") assert.match(String(outcome.reason), /room r already has/);
    writeFileSync(gate, "");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------- drain edge cases

test("a message written while the previous turn's result was still in the pipe keeps the agent working, and a drain cuts it instead of hibernating it", async () => {
  const h = await harness({ drainGraceMs: 200, drainInterruptGraceMs: 200, turnSettleMs: 5000 });
  const reuse = { dir: h.dir, hostId: h.hostId };
  let again: Harness | undefined;
  try {
    const gate = h.file("gate");
    await h.client.request("spawn", { agentId: "a1", spec: spec(h), message: `first [[stale-result:${gate}]]` });
    const events = h.watch("a1");
    await waitFor(() => results(events).length === 1, 5000, "first turn");
    await h.client.request("send", { agentId: "a1", message: "second" });
    // The stale result arrives after the second message was written.
    await waitFor(() => results(events).length === 2, 5000, "stale result");
    assert.equal((await h.activity("a1")).state, "working", "the second message's turn has not even started");
    h.client.close();
    await h.host.close();
    again = await harness({ reuse });
    const after = await again.activity("a1");
    assert.equal(after.state, "stopped");
    assert.equal(after.stopReason, "host_shutdown");
  } finally {
    if (again) await again.cleanup();
    else await h.cleanup();
  }
});

test("a send accepted just before a drain never starts a turn that the drain then hibernates silently", async () => {
  const h = await harness({ drainGraceMs: 200, drainInterruptGraceMs: 200 });
  const reuse = { dir: h.dir, hostId: h.hostId };
  let again: Harness | undefined;
  try {
    await h.client.request("spawn", { agentId: "a1", spec: spec(h), message: "hi" });
    const events = h.watch("a1");
    await waitFor(() => results(events).length === 1, 5000, "turn");
    await h.client.request("hibernate", { agentId: "a1" });
    let starting = false;
    h.client.on("agent_state", (agent) => {
      if (agent.agentId === "a1" && agent.state === "starting") starting = true;
    });
    const send = h.client.request("send", { agentId: "a1", message: "late" });
    await waitFor(() => starting, 5000, "start in progress");
    const closing = h.host.close();
    const [sent] = await Promise.allSettled([send, closing]);
    h.client.close();
    again = await harness({ reuse });
    const after = await again.activity("a1");
    if (sent.status === "fulfilled") {
      // Accepted: either its turn finished before the drain (its result is in
      // the log), or the drain cut it and says so — never a silent loss.
      const log = again.watch("a1");
      await waitFor(() => log.some((event) => event.ev.type === "host_process" && event.ev.subtype === "exited"), 5000, "log replayed");
      const late = log.findIndex((event) => event.ev.type === "host_user_message" && event.ev.text === "late");
      const answered = log.slice(late).some((event) => event.ev.type === "result");
      assert.ok(answered || (after.state === "stopped" && after.stopReason === "host_shutdown"), `state ${after.state}, answered ${answered}`);
    } else {
      assert.match(String(sent.reason), /draining|shutting down/);
    }
  } finally {
    if (again) await again.cleanup();
    else await h.cleanup();
  }
});

test("removing an agent tells its subscribers, and a recreated agent with the same id is read from its start", async () => {
  const h = await harness();
  try {
    await h.client.request("spawn", { agentId: "a1", spec: spec(h), message: "old life" });
    const old: EventMessage[] = [];
    const errors: string[] = [];
    let cursor = START_OF_LOG;
    const sub = h.client.subscribe("a1", START_OF_LOG, { onEvent: (event) => old.push(event), onError: (error) => errors.push(error.code) });
    await waitFor(() => results(old).length === 1, 5000, "old turn");
    cursor = sub.cursor();
    await h.client.request("remove", { agentId: "a1" });
    await waitFor(() => errors.includes("removed"), 5000, "removal notice");

    await h.client.request("spawn", { agentId: "a1", spec: spec(h), message: "new life" });
    // A consumer that kept the old cursor resubscribes with it.
    const fresh: EventMessage[] = [];
    h.client.subscribe("a1", cursor, { onEvent: (event) => fresh.push(event) });
    await waitFor(() => results(fresh).length === 1, 5000, "new agent's turn");
    assert.equal(fresh[0].seq, 0, "read from the new log's start");
    assert.equal(results(fresh)[0].ev.result, "echo: new life");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------- registry robustness

test("a corrupt registry is kept aside and the host starts empty; an unreadable one stops the start without being overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-registry-"));
  const dataDir = join(dir, "data");
  const options = { hostId: `registry-${process.pid}`, dataDir, socketPath: join(dir, "run", "h.sock"), agentBin: FAKE_CLAUDE };
  try {
    mkdirSync(dataDir, { recursive: true });
    const registry = join(dataDir, "registry.json");
    const torn = '{"version":1,"agents":[{"agentId":"a1","spec":';
    writeFileSync(registry, torn);
    const host = await AgentHost.start(options);
    assert.deepEqual(host.activity(), []);
    await host.close();
    const kept = readdirSync(dataDir).filter((name) => name.startsWith("registry.json.corrupt-"));
    assert.equal(kept.length, 1);
    assert.equal(readFileSync(join(dataDir, kept[0]), "utf8"), torn);

    const good = JSON.stringify({ version: 1, agents: [{ agentId: "keep", runtime: "claude", spec: { cwd: dir, agentWorker: true }, createdAt: 1, lifecycle: "hibernated", awaitingUser: false, lastActivityAt: 1, sessionId: "s" }] });
    writeFileSync(registry, good);
    chmodSync(registry, 0o000);
    try {
      await assert.rejects(AgentHost.start(options), /registry/);
    } finally {
      chmodSync(registry, 0o600);
    }
    assert.equal(readFileSync(registry, "utf8"), good, "an unreadable registry is never replaced");
    const again = await AgentHost.start(options);
    assert.deepEqual(
      again.activity().map((agent) => agent.agentId),
      ["keep"],
    );
    await again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- a descendant holding the CLI's pipes

test("a crash is noticed even while a descendant still holds the CLI's stdout open", async () => {
  const h = await harness();
  try {
    await h.client.request("spawn", { agentId: "a1", spec: spec(h), message: "daemonize [[inherit-stdout]]" });
    const events = h.watch("a1");
    await waitFor(() => results(events).length === 1, 5000, "turn");
    await h.client.request("send", { agentId: "a1", message: "[[crash]]" });
    await waitFor(() => h.host.activity()[0]?.state === "failed", 6000, "crash noticed");
    const { findAgentProcesses } = await import("./processTree.js");
    const left = await findAgentProcesses(h.hostId, "a1");
    assert.deepEqual(left.filter(isAlive), [], "the descendant was swept");
  } finally {
    await h.cleanup();
  }
});

test("stopping an agent whose descendant holds its stdout is graceful and prompt", async () => {
  const h = await harness({ stopGraceMs: 3000 });
  try {
    await h.client.request("spawn", { agentId: "a1", spec: spec(h), message: "daemonize [[inherit-stdout]]" });
    const events = h.watch("a1");
    await waitFor(() => results(events).length === 1, 5000, "turn");
    const started = Date.now();
    await h.client.request("stop", { agentId: "a1" });
    assert.ok(Date.now() - started < 2500, `stop took ${Date.now() - started}ms`);
    await waitFor(() => events.some((event) => event.ev.type === "host_process" && event.ev.subtype === "exited"), 5000, "exit logged");
    assert.equal(events.some((event) => event.ev.type === "host_process" && event.ev.subtype === "killed"), false, "it exited on SIGTERM, no SIGKILL needed");
  } finally {
    await h.cleanup();
  }
});
