// End to end across real processes: the agent host (its own service
// entrypoint), the real relay, and a consumer process holding the relay-side
// subscription, each on its own socket/port with data in a temp dir. Every
// kill below targets the exact pid of a process this test spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HostClient } from "../src/agentHost/hostClient.js";
import { isAlive } from "../src/agentHost/processTree.js";
import type { AgentActivity } from "../src/agentHost/protocol.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { FAKE_AGENT_BIN } from "./helpers/testServer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_ROOT = resolve(HERE, "..");
const HOST_ENTRY = resolve(RELAY_ROOT, "src/agentHost/main.ts");
const CONSUMER = resolve(HERE, "fixtures/host-consumer.ts");

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Env {
  dir: string;
  socketPath: string;
  dataDir: string;
  hostId: string;
  home: string;
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), "anywh-host-e2e-"));
  const home = join(dir, "home");
  mkdirSync(home);
  return { dir, socketPath: join(dir, "run", "host.sock"), dataDir: join(dir, "data"), hostId: `e2e-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, home };
}

function startHost(env: Env): { proc: ChildProcess; output: string[] } {
  const output: string[] = [];
  const proc = spawn(process.execPath, ["--import", "tsx", HOST_ENTRY, "--profile", "e2e", "--host-id", env.hostId, "--socket", env.socketPath, "--data-dir", env.dataDir], {
    cwd: RELAY_ROOT,
    env: {
      ...process.env,
      ANYWH_AGENT_HOST_DRAIN_GRACE_MS: "1000",
      ANYWH_AGENT_HOST_HIBERNATE: "off",
      RELAY_HOME_OVERRIDE: env.home,
      AGENT_BIN: FAKE_AGENT_BIN,
    },
  });
  proc.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  return { proc, output };
}

function startConsumer(env: Env, agentId: string, out: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", CONSUMER], {
    cwd: RELAY_ROOT,
    env: { ...process.env, HOST_SOCKET: env.socketPath, AGENT_ID: agentId, OUT: out },
    stdio: "ignore",
  });
}

function exited(proc: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  return new Promise((resolveExit) => proc.once("exit", (code, signal) => resolveExit({ code, signal })));
}

async function killExact(proc: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill(signal);
  await exited(proc);
}

async function connect(env: Env): Promise<HostClient> {
  const client = new HostClient({ socketPath: env.socketPath, reconnectMinMs: 20, reconnectMaxMs: 200 });
  client.start();
  await client.waitUntilConnected(15_000);
  return client;
}

async function relayActivity(relay: SpawnedServer): Promise<{ status: number; body: { hostConnected: boolean; aggregate?: string; agents?: AgentActivity[] } }> {
  const res = await fetch(`http://127.0.0.1:${relay.port}/agents/activity`);
  return { status: res.status, body: (await res.json()) as { hostConnected: boolean; aggregate?: string; agents?: AgentActivity[] } };
}

async function agentViaRelay(relay: SpawnedServer, agentId: string): Promise<AgentActivity | undefined> {
  const { status, body } = await relayActivity(relay);
  return status === 200 ? body.agents?.find((agent) => agent.agentId === agentId) : undefined;
}

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/** Every record of an agent's log, straight from the host's files. */
function logSeqs(env: Env, agentId: string): number[] {
  const dir = join(env.dataDir, "logs", agentId);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => readLines<{ seq: number }>(join(dir, name)).map((record) => record.seq));
}

test("restarting the relay mid-turn interrupts nothing: the turn goes on, and the relay side sees every event exactly once", async () => {
  const env = makeEnv();
  const host = startHost(env);
  const procs: ChildProcess[] = [host.proc];
  const relays: SpawnedServer[] = [];
  let control: HostClient | undefined;
  try {
    control = await connect(env);
    const gate = join(env.dir, "gate");
    await control.request("spawn", { agentId: "a1", spec: { cwd: env.dir }, message: `long build [[gate:${gate}]] [[events:5]]` });

    const out = join(env.dir, "consumer.jsonl");
    const relay1 = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: env.socketPath });
    relays.push(relay1);
    const consumer1 = startConsumer(env, "a1", out);
    procs.push(consumer1);
    await waitFor(() => readLines<{ type: string }>(out).some((record) => record.type === "assistant"), 15_000, "first consumer to see the turn");
    let before: AgentActivity | undefined;
    await waitFor(async () => (before = await agentViaRelay(relay1, "a1"))?.state === "working", 15_000, "relay 1 to report the turn");

    // The relay (and its subscription) go down hard, mid-turn.
    await killExact(relay1.proc);
    await killExact(consumer1);

    const relay2 = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: env.socketPath });
    relays.push(relay2);
    const consumer2 = startConsumer(env, "a1", out);
    procs.push(consumer2);
    let during: AgentActivity | undefined;
    await waitFor(async () => (during = await agentViaRelay(relay2, "a1")) !== undefined, 15_000, "relay 2 connected to the host");
    assert.equal(during!.state, "working", "the turn is still in flight after the relay restart");
    assert.equal(during!.pid, before!.pid, "same agent process");
    await waitFor(() => (readLines<{ next: number }>(out).at(-1)?.next ?? 0) >= during!.nextOffset, 15_000, "second consumer caught up");

    // The turn goes on, live, to the new relay side.
    writeFileSync(gate, "");
    await waitFor(() => readLines<{ type: string }>(out).some((record) => record.type === "result"), 15_000, "result after the restart");
    await waitFor(async () => (await agentViaRelay(relay2, "a1"))?.state === "idle", 15_000, "idle after the turn");

    const received = readLines<{ seq: number }>(out).map((record) => record.seq);
    assert.deepEqual(received, logSeqs(env, "a1"), "consumer saw exactly the host's log: nothing lost, nothing twice");
    const { body } = await relayActivity(relay2);
    assert.equal(body.aggregate, "idle");

    // SIGTERM is a clean drain: the idle agent is hibernated, the host exits 0.
    control.close();
    control = undefined;
    host.proc.kill("SIGTERM");
    const { code } = await exited(host.proc);
    assert.equal(code, 0, host.output.join(""));
    assert.equal(isAlive(before!.pid!), false);
  } finally {
    control?.close();
    for (const proc of procs) await killExact(proc);
    for (const relay of relays) relay.cleanup();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("killing the host brings its agents back stopped and resumable, with nothing of the old run left running", async () => {
  const env = makeEnv();
  const procs: ChildProcess[] = [];
  let relay: SpawnedServer | undefined;
  let control: HostClient | undefined;
  try {
    const host1 = startHost(env);
    procs.push(host1.proc);
    control = await connect(env);
    const pidFile = join(env.dir, "pids.json");
    await control.request("spawn", { agentId: "a1", spec: { cwd: env.dir }, message: "warm up" });
    await waitFor(() => control!.request<{ agents: AgentActivity[] }>("activity").then(({ agents }) => agents[0]?.state === "idle"), 10_000, "first turn");
    await control.request("send", { agentId: "a1", message: `start the dev server [[children:${pidFile}]]` });
    await waitFor(() => existsSync(pidFile), 10_000, "tool processes started");
    const { inGroup, ownSession } = JSON.parse(readFileSync(pidFile, "utf8")) as { inGroup: number; ownSession: number };
    const { agents } = await control.request<{ agents: AgentActivity[] }>("activity");
    const { pid: claudePid, sessionId } = agents[0];
    assert.equal(agents[0].state, "working");

    // The host dies without any chance to clean up.
    await killExact(host1.proc, "SIGKILL");
    assert.ok(isAlive(claudePid!), "the agent outlives a SIGKILLed host (it is in its own session)");

    const host2 = startHost(env);
    procs.push(host2.proc);
    relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: env.socketPath });
    let restored: AgentActivity | undefined;
    await waitFor(async () => (restored = await agentViaRelay(relay!, "a1")) !== undefined, 15_000, "relay sees the restarted host");
    assert.equal(restored!.state, "stopped");
    assert.equal(restored!.stopReason, "host_restart");
    assert.equal(restored!.resumable, true);
    assert.equal(restored!.alive, false);
    for (const pid of [claudePid!, inGroup, ownSession]) assert.equal(isAlive(pid), false, `pid ${pid} left over from the old host`);

    // The control client reconnected to the new host by itself.
    await control.waitUntilConnected(15_000);
    assert.deepEqual(await control.request("send", { agentId: "a1", message: "pick up where you left off" }), { duringTurn: false, resumed: true });
    await waitFor(async () => (await agentViaRelay(relay!, "a1"))?.state === "idle", 15_000, "resumed turn done");
    const after = await agentViaRelay(relay, "a1");
    assert.equal(after!.sessionId, sessionId);
  } finally {
    control?.close();
    for (const proc of procs) await killExact(proc);
    relay?.cleanup();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("the relay reports the host as unavailable instead of an empty machine", async () => {
  const env = makeEnv();
  const relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: env.socketPath });
  try {
    const { status, body } = await relayActivity(relay);
    assert.equal(status, 503);
    assert.equal(body.hostConnected, false);
  } finally {
    relay.cleanup();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("the host refuses to start without an explicit profile, even with ANYWH_PROFILE inherited from the environment", async () => {
  const env = makeEnv();
  try {
    const proc = spawn(process.execPath, ["--import", "tsx", HOST_ENTRY], {
      cwd: RELAY_ROOT,
      env: { ...process.env, ANYWH_PROFILE: "pessoal", ANYWH_AGENT_HOST_SOCKET: env.socketPath, ANYWH_AGENT_HOST_DIR: env.dataDir, AGENT_BIN: FAKE_AGENT_BIN },
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const { code } = await exited(proc);
    assert.notEqual(code, 0);
    assert.match(stderr, /--profile/);
    assert.equal(existsSync(env.socketPath), false);
    assert.equal(existsSync(env.dataDir), false);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test("a relay with no profile does not connect to the machine's `default` agent host", async () => {
  const { mkdirSync, chmodSync } = await import("node:fs");
  const { createServer } = await import("node:net");
  const runtime = mkdtempSync(join(tmpdir(), "anywh-xdg-"));
  // A live `default` host socket where the default path would point.
  const socketDir = join(runtime, "anywh");
  mkdirSync(socketDir, { mode: 0o700 });
  const socketPath = join(socketDir, "agent-host-default.sock");
  let connections = 0;
  const listener = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolveListen) => listener.listen(socketPath, () => resolveListen()));
  chmodSync(socketPath, 0o600);
  const relay = await spawnRelay({ XDG_RUNTIME_DIR: runtime, ANYWH_PROFILE: "", ANYWH_AGENT_HOST_SOCKET: "" });
  try {
    const { status, body } = await relayActivity(relay);
    assert.equal(status, 503);
    assert.equal(body.hostConnected, false);
    assert.match((body as { error?: string }).error ?? "", /ANYWH_PROFILE/);
    assert.equal(connections, 0, "nothing dialed the default host");
  } finally {
    relay.cleanup();
    await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
    rmSync(runtime, { recursive: true, force: true });
  }
});
