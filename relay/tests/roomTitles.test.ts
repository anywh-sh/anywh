// Titles of a room's agents, across real processes (the agent host running the
// fake `claude`, and the real relay): the principal and each worker get a
// short generated title, like an ordinary session, instead of keeping the
// message or task they were started with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostEnvDir, startHostProcess } from "./helpers/agentHostProcess.js";
import { spawnRelay } from "./helpers/spawnedServer.js";
import { collectUntil, connectSession, sendUserMessage } from "./helpers/wsClient.js";

const marker = (tool: string, args: unknown): string => `[[room:${tool}:${Buffer.from(JSON.stringify(args)).toString("base64url")}]]`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LONG = "Investigate why the websocket reconnect loop spins forever when the relay restarts in the middle of a turn and report";

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await Promise.resolve(check()).catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function withRoomStack(relayEnv: Record<string, string>, run: (ctx: { base: string; dir: string; port: number }) => Promise<void>): Promise<void> {
  const { dir, home } = hostEnvDir();
  const host = startHostProcess(dir, home);
  const relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, ...relayEnv });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    await until(async () => (await fetch(`${base}/agents/activity`)).status === 200, "host connection");
    await run({ base, dir, port: relay.port });
  } finally {
    relay.cleanup();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const titleOf = async (base: string, roomId: string, agentId: string): Promise<string | null> =>
  ((await (await fetch(`${base}/rooms/${roomId}`)).json()) as { members: { id: string; title: string | null }[] }).members.find((m) => m.id === agentId)?.title ?? null;

test("the principal and a worker get a generated title, not the message or task they started with", async () => {
  await withRoomStack({ FAKE_CLAUDE_REPLY: "Reconnect loop" }, async ({ base, dir, port }) => {
    const created = (await (await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", cwd: dir, title: LONG, firstMessage: LONG }) })).json()) as { roomId: string };
    const roomId = created.roomId;
    // Provisional until the generated one lands.
    await until(async () => (await titleOf(base, roomId, roomId)) === "Reconnect loop", "the principal's generated title");

    const socket = await connectSession(port, roomId);
    const gate = join(dir, "gate");
    const done = collectUntil(socket, (m) => m.type === "agent_event" && (m.event as { type?: string }).type === "tool_ended", 30_000);
    sendUserMessage(socket, marker("delegate", { runtime: "claude", model: "haiku", task: `${LONG} [[gate:${gate}]]` }));
    const messages = await done;
    const ended = messages.find((m) => m.type === "agent_event" && (m.event as { type?: string }).type === "tool_ended");
    const workerId = (JSON.parse(String((ended!.event as { content?: unknown }).content)) as { agentId: string }).agentId;
    await until(async () => (await titleOf(base, roomId, workerId)) === "Reconnect loop", "the worker's generated title");
    writeFileSync(gate, "");
    socket.close();
  });
});

test("a manual rename that lands before the generated title is not overwritten by it", async () => {
  await withRoomStack({ FAKE_CLAUDE_REPLY: "Generated", FAKE_CLAUDE_TITLE_DELAY_MS: "600" }, async ({ base, dir }) => {
    const created = (await (await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", cwd: dir, firstMessage: LONG }) })).json()) as { roomId: string };
    const roomId = created.roomId;
    assert.equal((await fetch(`${base}/sessions/rename`, { method: "POST", body: JSON.stringify({ id: roomId, title: "By hand" }) })).status, 200);
    await sleep(1200);
    assert.equal(await titleOf(base, roomId, roomId), "By hand");
  });
});
