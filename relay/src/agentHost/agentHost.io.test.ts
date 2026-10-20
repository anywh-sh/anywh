// The agent host with real `claude` stand-ins: the fake CLI from
// tests/fixtures (the one sanctioned mock boundary) in its persistent
// stream-json mode, real child processes, a real socket and real logs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "./agentHost.js";
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

async function harness(options: { stopGraceMs?: number } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-agenthost-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const hostId = `test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const host = await AgentHost.start({
    hostId,
    dataDir: join(dir, "data"),
    socketPath: join(dir, "run", "host.sock"),
    agentBin: FAKE_CLAUDE,
    homeOverride: home,
    stopGraceMs: options.stopGraceMs ?? 3000,
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
    assert.equal(env.ANYWH_AGENT_HOST_ID, h.hostId);
    assert.equal(env.ANYWH_AGENT_ID, "a1");
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
    assert.equal((await h.activity("a1")).state, "idle");
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
  const orphan = spawn("sleep", ["300"], { detached: true, stdio: "ignore", env: { ...process.env, ANYWH_AGENT_HOST_ID: hostId, ANYWH_AGENT_ID: "gone" } });
  const otherHost = spawn("sleep", ["300"], { detached: true, stdio: "ignore", env: { ...process.env, ANYWH_AGENT_HOST_ID: `${hostId}-other` } });
  const unrelated = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  try {
    await waitFor(() => [orphan, otherHost, unrelated].every((child) => child.pid !== undefined && isAlive(child.pid)), 3000, "sleepers");
    const host = await AgentHost.start({ hostId, dataDir: join(dir, "data"), socketPath: join(dir, "run", "h.sock"), agentBin: FAKE_CLAUDE });
    await host.close();
    assert.equal(isAlive(orphan.pid!), false);
    assert.equal(isAlive(otherHost.pid!), true);
    assert.equal(isAlive(unrelated.pid!), true);
  } finally {
    for (const child of [orphan, otherHost, unrelated]) if (child.pid && isAlive(child.pid)) process.kill(child.pid, "SIGKILL");
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
