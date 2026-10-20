// The relay-side driver of an agent that lives in the agent host: a real
// host (in this process), its real socket and logs, and the fake `claude`
// (the sanctioned stand-in) in its persistent stream-json mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "../agentHost/agentHost.js";
import { HostClient } from "../agentHost/hostClient.js";
import type { AgentActivity } from "../agentHost/protocol.js";
import type { AgentEvent } from "../protocol/agent-event.js";
import { claudeRuntimeDef } from "./defs/claude/index.js";
import { HostSessionDriver } from "./hostSessionDriver.js";
import type { RoomAgentSetup, TurnContext } from "./types.js";

const FAKE_CLAUDE = resolve(import.meta.dirname, "../../tests/fixtures/fake-claude.mjs");

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function withHost(run: (h: { dir: string; client: HostClient; host: AgentHost }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-hostdriver-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const host = await AgentHost.start({
    hostId: `hd-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    dataDir: join(dir, "data"),
    socketPath: join(dir, "run", "host.sock"),
    agentBin: FAKE_CLAUDE,
    homeOverride: home,
    stopGraceMs: 2000,
    drainGraceMs: 500,
    turnSettleMs: 200,
  });
  const client = new HostClient({ socketPath: host.socketPath, reconnectMinMs: 10, reconnectMaxMs: 50 });
  client.start();
  await client.waitUntilConnected();
  try {
    await run({ dir, client, host });
  } finally {
    client.close();
    await host.close({ drainGraceMs: 200 });
    rmSync(dir, { recursive: true, force: true });
  }
}

const ctx = (dir: string, prompt: string): TurnContext => ({ cwd: dir, prompt, permissionModeId: "bypassPermissions" });

const workerSetup = (): RoomAgentSetup => ({ role: "worker", instructions: "work", tools: [], bridgeServerName: "anywh-room", bridgeUrl: "http://127.0.0.1:9/room/x/y" });

function driverFor(client: HostClient | undefined, agentId: string, initialSessionId?: string, admit?: () => string | undefined): HostSessionDriver {
  return new HostSessionDriver(claudeRuntimeDef, { initialSessionId, binding: { client, agentId, roomId: "room-a", setup: workerSetup, ...(admit ? { admit } : {}) } });
}

async function agent(client: HostClient, agentId: string): Promise<AgentActivity | undefined> {
  const { agents } = await client.request<{ agents: AgentActivity[] }>("activity");
  return agents.find((candidate) => candidate.agentId === agentId);
}

test("turns run in one host process: the first spawns the agent, the next ones reuse it, events come mapped", async () => {
  await withHost(async ({ dir, client }) => {
    const driver = driverFor(client, "w1");
    const first: AgentEvent[] = [];
    const one = await driver.sendTurn(ctx(dir, "hello"), (event) => first.push(event));
    assert.equal(one.stopped, false);
    assert.equal(one.lastAssistantText, "echo: hello");
    assert.ok(one.contextUsage && one.contextUsage.contextWindowSize === 200000, "context usage read off the result");
    assert.ok(first.some((event) => event.type === "text" && event.text === "echo: hello"));
    const sessionId = driver.getSessionId();
    assert.ok(sessionId, "the session id is learned from the stream");
    const pid = (await agent(client, "w1"))!.pid;

    const second: AgentEvent[] = [];
    const two = await driver.sendTurn(ctx(dir, "again"), (event) => second.push(event));
    assert.equal(two.lastAssistantText, "echo: again");
    assert.ok(!second.some((event) => event.type === "text" && event.text === "echo: hello"), "nothing of the first turn leaks into the second");
    assert.equal((await agent(client, "w1"))!.pid, pid, "same process");
    assert.equal((await agent(client, "w1"))!.roomId, "room-a");
    driver.dispose();
  });
});

test("a driver created after a relay restart picks the agent up where it is, and only sees its own turn", async () => {
  await withHost(async ({ dir, client }) => {
    const before = driverFor(client, "w2");
    await before.sendTurn(ctx(dir, "first"), () => {});
    const sessionId = before.getSessionId()!;
    before.dispose();

    const after = driverFor(client, "w2", sessionId);
    const events: AgentEvent[] = [];
    const result = await after.sendTurn(ctx(dir, "second"), (event) => events.push(event));
    assert.equal(result.lastAssistantText, "echo: second");
    assert.deepEqual(
      events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text),
      ["echo: second"],
    );
    assert.equal(after.getSessionId(), sessionId);
    after.dispose();
  });
});

test("Stop interrupts the turn in the host and keeps the agent; a crash fails the turn", async () => {
  await withHost(async ({ dir, client }) => {
    const driver = driverFor(client, "w3");
    await driver.sendTurn(ctx(dir, "warm up"), () => {});
    const pending = driver.sendTurn(ctx(dir, "work [[hang]]"), () => {});
    await waitFor(async () => (await agent(client, "w3"))?.state === "working", 8000, "turn in flight");
    assert.equal(driver.stop(), true);
    const stopped = await pending;
    assert.equal(stopped.stopped, true);
    assert.equal((await agent(client, "w3"))?.alive, true, "the process survives a Stop");

    await assert.rejects(driver.sendTurn(ctx(dir, "boom [[crash]]"), () => {}), /exited during the turn/);
    const next = await driver.sendTurn(ctx(dir, "after the crash"), () => {});
    assert.equal(next.lastAssistantText, "echo: after the crash", "the next turn resumes the agent");
    assert.equal(driver.stop(), false, "nothing to stop between turns");
    driver.dispose();
  });
});

test("an agent the host lost is recreated on the same session; /clear starts a fresh one", async () => {
  await withHost(async ({ dir, client }) => {
    const driver = driverFor(client, "w4");
    await driver.sendTurn(ctx(dir, "remember me"), () => {});
    const sessionId = driver.getSessionId()!;
    driver.dispose();
    await client.request("remove", { agentId: "w4" });
    await waitFor(async () => (await agent(client, "w4")) === undefined, 8000, "agent removed");

    const again = driverFor(client, "w4", sessionId);
    await again.sendTurn(ctx(dir, "still there?"), () => {});
    assert.equal(again.getSessionId(), sessionId, "resumed, not restarted");

    again.resetSessionId();
    await again.sendTurn(ctx(dir, "fresh start"), () => {});
    assert.notEqual(again.getSessionId(), sessionId, "a new conversation after /clear");
    again.dispose();
  });
});

test("with no agent host the turn fails saying so, and never runs anywhere else", async () => {
  const driver = driverFor(undefined, "w5");
  await assert.rejects(driver.sendTurn(ctx(tmpdir(), "hi"), () => {}), /agent host/);
});

test("a host that is down makes the turn fail fast instead of hanging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-hostdriver-down-"));
  try {
    writeFileSync(join(dir, "placeholder"), "");
    const client = new HostClient({ socketPath: join(dir, "nothing.sock"), reconnectMinMs: 10, reconnectMaxMs: 50 });
    client.start();
    const driver = new HostSessionDriver(claudeRuntimeDef, { binding: { client, agentId: "w6", roomId: "room-a", setup: workerSetup }, connectTimeoutMs: 300 });
    await assert.rejects(driver.sendTurn(ctx(dir, "hi"), () => {}), /not reachable/);
    client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop with the host unreachable ends the turn here instead of leaving it hanging", async () => {
  await withHost(async ({ dir, client }) => {
    const driver = driverFor(client, "w7");
    const pending = driver.sendTurn(ctx(dir, "work [[hang]]"), () => {});
    await waitFor(async () => (await agent(client, "w7"))?.state === "working", 8000, "turn in flight");
    client.close();
    assert.equal(driver.stop(), true);
    assert.equal((await pending).stopped, true);
    driver.dispose();
  });
});

test("after /clear, late records of the old conversation never bring its session back", async () => {
  await withHost(async ({ dir, client }) => {
    const driver = driverFor(client, "w8");
    await driver.sendTurn(ctx(dir, "start one [[subagent]]"), () => {});
    const old = driver.getSessionId()!;
    const taskId = driver.listSubtasks()[0]?.taskId;
    assert.ok(taskId, "a running subtask");
    driver.resetSessionId();
    // The old conversation keeps talking: its subagent ends, with records
    // carrying the old session id.
    const watcher = new HostClient({ socketPath: (client as unknown as { options: { socketPath: string } }).options.socketPath });
    watcher.start();
    await watcher.waitUntilConnected();
    await watcher.request("stop_task", { agentId: "w8", taskId });
    await waitFor(async () => (await agent(client, "w8"))?.backgroundTasks === 0, 8000, "subagent stopped");
    watcher.close();
    assert.equal(driver.getSessionId(), undefined);
    await driver.sendTurn(ctx(dir, "fresh"), () => {});
    assert.notEqual(driver.getSessionId(), old);
    driver.dispose();
  });
});

test("a member that may not run is never started: refused, stopped, without its room wiring, or after its session is gone", async () => {
  await withHost(async ({ dir, client }) => {
    let refusal: string | undefined = "This agent was stopped.";
    const driver = driverFor(client, "w9", undefined, () => refusal);
    await assert.rejects(driver.sendTurn(ctx(dir, "hi"), () => {}), /was stopped/);
    const bare = new HostSessionDriver(claudeRuntimeDef, { binding: { client, agentId: "w10", roomId: "room-a", setup: () => undefined } });
    await assert.rejects(bare.sendTurn(ctx(dir, "hi"), () => {}), /not started without its restrictions/);
    assert.equal(await agent(client, "w9"), undefined);
    assert.equal(await agent(client, "w10"), undefined, "nothing was spawned");

    refusal = undefined;
    await driver.sendTurn(ctx(dir, "now allowed"), () => {});
    driver.dispose();
    await assert.rejects(driver.sendTurn(ctx(dir, "after removal"), () => {}), /was removed/);
  });
});

test("Stop before the message reached the host: the turn ends stopped and nothing is started", async () => {
  await withHost(async ({ dir, client }) => {
    const driver = driverFor(client, "w11");
    const pending = driver.sendTurn(ctx(dir, "never sent"), () => {});
    assert.equal(driver.stop(), true);
    assert.equal((await pending).stopped, true);
    assert.equal(await agent(client, "w11"), undefined, "no agent was created");
    driver.dispose();
  });
});

/** A real client that runs `hook` the moment a request of `method` goes out
 * (once): how a Stop lands in the middle of the driver's own awaits. */
class HookedClient extends HostClient {
  hook: { method: string; run: () => void } | undefined;
  override request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const hook = this.hook;
    if (hook && hook.method === method) {
      this.hook = undefined;
      hook.run();
    }
    return super.request<T>(method, params);
  }
}

test("a Stop that lands while the driver looks the agent up keeps the message from ever reaching the host", async () => {
  await withHost(async ({ dir, client, host }) => {
    const first = driverFor(client, "w12");
    await first.sendTurn(ctx(dir, "warm up"), () => {});
    first.dispose();
    await client.request("stop", { agentId: "w12" });
    assert.equal((await agent(client, "w12"))?.state, "stopped");

    const hooked = new HookedClient({ socketPath: host.socketPath, reconnectMinMs: 10, reconnectMaxMs: 50 });
    hooked.start();
    await hooked.waitUntilConnected();
    try {
      const driver = driverFor(hooked, "w12");
      hooked.hook = { method: "activity", run: () => driver.stop() };
      const result = await driver.sendTurn(ctx(dir, "should never arrive"), () => {});
      assert.equal(result.stopped, true);
      await new Promise((r) => setTimeout(r, 300));
      const after = await agent(client, "w12");
      assert.equal(after?.state, "stopped", "the stopped agent was not started again");
      assert.equal(after?.alive, false);
      driver.dispose();
    } finally {
      hooked.close();
    }
  });
});

test("following a Claude turn without a fresh transcript load reads from the saved cursor, missing nothing of it", async () => {
  await withHost(async ({ dir, client }) => {
    const gate = join(dir, "follow-gate");
    await client.request("spawn", { agentId: "w13", roomId: "room-a", spec: { cwd: dir }, message: `long [[gate:${gate}]] [[events:3]]` });
    // Where a relay that saw the turn begin would have stopped reading.
    let cursor: { nextOffset: number; lastSeq: number; incarnation?: string } | undefined;
    const seen: string[] = [];
    const watcher = new HostClient({ socketPath: (client as unknown as { options: { socketPath: string } }).options.socketPath });
    watcher.start();
    await watcher.waitUntilConnected();
    watcher.subscribe("w13", { nextOffset: 0, lastSeq: -1 }, {
      onEvent: (record) => {
        seen.push(String(record.ev.type));
        if (record.ev.type === "host_user_message") cursor = { nextOffset: record.next, lastSeq: record.seq, incarnation: record.inc };
      },
    });
    await waitFor(() => seen.filter((type) => type === "assistant").length >= 4, 8000, "the turn's first output");
    watcher.close();

    const driver = new HostSessionDriver(claudeRuntimeDef, {
      binding: { client, agentId: "w13", roomId: "room-a", setup: workerSetup, cursors: { get: () => cursor, set: () => {} } },
    });
    const events: AgentEvent[] = [];
    const following = driver.followTurnInFlight((event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === "text" && event.text === "progress 3/3"), 8000, "the output from before the follow");
    writeFileSync(gate, "");
    const result = await following;
    assert.equal(result.stopped, false);
    assert.deepEqual(
      events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text),
      ["progress 1/3", "progress 2/3", "progress 3/3", "done after gate"],
    );
    driver.dispose();
  });
});
