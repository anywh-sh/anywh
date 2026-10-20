// Removing an agent of a room (it and the agents below it) with a window to
// undo it, across real processes: the agent host running the fake `claude`
// and the real relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentActivity } from "../src/agentHost/protocol.js";
import { hostEnvDir, startHostProcess } from "./helpers/agentHostProcess.js";
import { spawnRelay } from "./helpers/spawnedServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

const UNDO_MS = 1500;
const marker = (tool: string, args: unknown): string => `[[room:${tool}:${Buffer.from(JSON.stringify(args)).toString("base64url")}]]`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await Promise.resolve(check()).catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

test("removing an agent stops and hides it with the agents below it; undo brings them back; after the window they are gone for good", async () => {
  const { dir, home } = hostEnvDir();
  const host = startHostProcess(dir, home);
  const relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_ROOM_REMOVE_UNDO_MS: String(UNDO_MS) });
  const base = `http://127.0.0.1:${relay.port}`;
  const post = (path: string): Promise<Response> => fetch(`${base}${path}`, { method: "POST" });
  const ids = async (roomId: string): Promise<string[]> => ((await (await fetch(`${base}/rooms/${roomId}`)).json()) as { members: { id: string }[] }).members.map((m) => m.id);
  const hostAgents = async (): Promise<AgentActivity[]> => ((await (await fetch(`${base}/agents/activity`)).json()) as { agents: AgentActivity[] }).agents;
  try {
    await until(async () => (await fetch(`${base}/agents/activity`)).status === 200, "host connection");
    const created = (await (await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", cwd: dir }) })).json()) as { roomId: string };
    const roomId = created.roomId;
    const socket = await connectSession(relay.port, roomId);
    const gate = join(dir, "gate");
    const delegate = async (args: Record<string, unknown>): Promise<string> => {
      const done = collectUntil(socket, isTurnEnded, 30_000);
      sendUserMessage(socket, marker("delegate", { runtime: "claude", model: "haiku", ...args }));
      const messages = await done;
      const ended = messages.find((m) => m.type === "agent_event" && (m.event as { type?: string }).type === "tool_ended");
      return (JSON.parse(String((ended!.event as { content?: unknown }).content)) as { agentId: string }).agentId;
    };
    const parentId = await delegate({ task: `parent [[gate:${gate}]]` });
    const childId = await delegate({ task: `child [[gate:${gate}]]`, parentId });
    const otherId = await delegate({ task: `other [[gate:${gate}]]` });
    await until(async () => (await hostAgents()).filter((a) => a.state === "working").length === 3, "three agents at work");

    assert.equal((await post(`/rooms/${roomId}/agents/${roomId}/remove`)).status, 400, "the principal is not removed this way");
    assert.equal((await post(`/rooms/${roomId}/agents/nope/remove`)).status, 404);
    const removed = await post(`/rooms/${roomId}/agents/${parentId}/remove`);
    assert.equal(removed.status, 200);
    const body = (await removed.json()) as { removed: string[]; undoMs: number };
    assert.deepEqual([...body.removed].sort(), [parentId, childId].sort());
    assert.equal(body.undoMs, UNDO_MS);
    assert.deepEqual((await ids(roomId)).sort(), [roomId, otherId].sort(), "hidden at once");
    await until(async () => {
      const agents = await hostAgents();
      return [parentId, childId].every((id) => agents.find((a) => a.agentId === id)?.alive === false) && agents.find((a) => a.agentId === otherId)?.state === "working";
    }, "the removed agents stopped in the host, the other one untouched");
    assert.equal((await post(`/rooms/${roomId}/agents/${parentId}/remove`)).status, 404, "removing twice");

    // Undo within the window.
    assert.equal((await post(`/rooms/${roomId}/agents/${childId}/restore`)).status, 404, "an agent comes back with the one that was removed, not alone");
    const restored = await post(`/rooms/${roomId}/agents/${parentId}/restore`);
    assert.equal(restored.status, 200);
    assert.deepEqual(((await restored.json()) as { restored: string[] }).restored.sort(), [parentId, childId].sort());
    assert.deepEqual((await ids(roomId)).sort(), [roomId, parentId, childId, otherId].sort());
    await sleep(UNDO_MS + 500);
    assert.deepEqual((await ids(roomId)).sort(), [roomId, parentId, childId, otherId].sort(), "an undone removal is never carried out");
    assert.equal((await post(`/rooms/${roomId}/agents/${parentId}/restore`)).status, 404, "nothing to restore");

    // Remove for good.
    assert.equal((await post(`/rooms/${roomId}/agents/${parentId}/remove`)).status, 200);
    await until(async () => (await ids(roomId)).length === 2 && (await hostAgents()).every((a) => a.agentId !== parentId && a.agentId !== childId), "the subtree deleted after the window");
    const sessions = ((await (await fetch(`${base}/sessions`)).json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    assert.ok(sessions.includes(roomId));
    assert.equal((await post(`/rooms/${roomId}/agents/${parentId}/restore`)).status, 404, "too late");
    writeFileSync(gate, "");
    socket.close();
  } finally {
    relay.cleanup();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a removal that was waiting out its window when the relay stopped is finished by the next one", async () => {
  const { dir, home } = hostEnvDir();
  const host = startHostProcess(dir, home);
  const sessionsFile = join(dir, "profile.json");
  const entry = (title: string, room: unknown) => ({ agentId: "claude", sessionId: {}, title, cwd: { cwd: dir, locked: false }, lastActiveAt: Date.now(), room });
  const worker = (parentId: string, at: number) => entry("Worker", { roomId: "r1", role: "worker", parentId, createdBy: "agent", task: "t", stopped: { reason: "removed", at } });
  writeFileSync(
    sessionsFile,
    JSON.stringify({
      r1: entry("Room", { roomId: "r1", role: "principal", createdBy: "user", task: "", undeliveredReports: [] }),
      old: worker("r1", 1),
      oldChild: worker("old", 1),
      fresh: worker("r1", Date.now()),
    }),
  );
  const relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_SESSIONS_FILE: sessionsFile, RELAY_ROOM_REMOVE_UNDO_MS: "3000" });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    const onDisk = (): string[] => Object.keys(JSON.parse(readFileSync(sessionsFile, "utf8")) as Record<string, unknown>).sort();
    await until(() => !onDisk().includes("old") && !onDisk().includes("oldChild"), "the expired removal deleted");
    assert.ok(onDisk().includes("fresh"), "one still inside its window is kept");
    assert.deepEqual(((await (await fetch(`${base}/rooms/r1`)).json()) as { members: { id: string }[] }).members.map((m) => m.id), ["r1"], "and stays hidden");
    assert.equal((await fetch(`${base}/rooms/r1/agents/fresh/restore`, { method: "POST" })).status, 200, "it can still be undone after the restart");
    await sleep(3500);
    assert.ok(onDisk().includes("fresh"), "once restored it stays");
  } finally {
    relay.cleanup();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
