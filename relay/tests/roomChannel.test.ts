// The state of a whole room on one WebSocket, across real processes: the
// agent host running nine fake `claude` workers (with the principal, the room's ten) and the real relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { hostEnvDir, startHostProcess } from "./helpers/agentHostProcess.js";
import { spawnRelay } from "./helpers/spawnedServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

const marker = (tool: string, args: unknown): string => `[[room:${tool}:${Buffer.from(JSON.stringify(args)).toString("base64url")}]]`;

test("ten agents' state (the principal and nine workers), reports and totals arrive on one room channel, live", async () => {
  const { dir, home } = hostEnvDir();
  const host = startHostProcess(dir, home);
  const relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath });
  const base = `http://127.0.0.1:${relay.port}`;
  const deadline = (): number => Date.now() + 30_000;
  try {
    for (const end = deadline(); (await fetch(`${base}/agents/activity`).catch(() => ({ status: 0 }))).status !== 200; ) {
      if (Date.now() > end) throw new Error("host not connected");
      await new Promise((r) => setTimeout(r, 25));
    }
    const created = (await (await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", cwd: dir }) })).json()) as { roomId: string };
    const roomId = created.roomId;

    // The channel for a room that does not exist closes with 4404.
    const missing = new WebSocket(`ws://127.0.0.1:${relay.port}/rooms/nope/watch`);
    const code = await new Promise<number>((resolve, reject) => {
      missing.once("close", (c) => resolve(c));
      missing.once("error", reject);
    });
    assert.equal(code, 4404);

    // One socket, opened before any agent exists, sees all of them.
    const messages: Record<string, unknown>[] = [];
    const watcher = new WebSocket(`ws://127.0.0.1:${relay.port}/rooms/${roomId}/watch`);
    watcher.on("message", (raw: Buffer) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      watcher.once("open", () => resolve());
      watcher.once("error", reject);
    });
    const waitMsg = async (check: () => boolean, what: string): Promise<void> => {
      for (const end = deadline(); !check(); ) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(messages.slice(-5))}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await waitMsg(() => messages.some((m) => m.type === "room_snapshot"), "the snapshot");
    const snapshot = messages[0] as { agents: { agentId: string; role: string }[]; summary: { counts: Record<string, number> } };
    assert.deepEqual(snapshot.agents.map((a) => a.role), ["principal"]);

    const gate = join(dir, "gate");
    const principal = await connectSession(relay.port, roomId);
    const delegations = Array.from({ length: 9 }, (_, i) => marker("delegate", { task: `task ${i} [[gate:${gate}]] ${marker("report", { status: "done", summary: `result ${i}`, artifacts: [] })}`, runtime: "claude", model: "haiku" })).join(" ");
    const done = collectUntil(principal, isTurnEnded, 60_000);
    sendUserMessage(principal, delegations);
    await done;
    principal.close();

    const latest = (): Map<string, { state: string; report?: { summary: string } }> => {
      const byId = new Map<string, { state: string; report?: { summary: string } }>();
      for (const m of messages) {
        if (m.type === "room_snapshot") for (const a of (m as { agents: { agentId: string; state: string }[] }).agents) byId.set(a.agentId, a);
        if (m.type === "room_agent_state") byId.set((m.agent as { agentId: string }).agentId, m.agent as { state: string });
      }
      return byId;
    };
    const lastSummary = (): { counts: Record<string, number>; live: number; liveLimit: number } | undefined =>
      [...messages].reverse().map((m) => (m.type === "room_summary" ? m.summary : m.type === "room_snapshot" ? m.summary : undefined)).find((s) => s !== undefined) as never;
    const workers = (): { state: string; report?: { summary: string } }[] => [...latest().entries()].filter(([id]) => id !== roomId).map(([, agent]) => agent);
    await waitMsg(() => workers().filter((a) => a.state === "working").length === 9, "nine workers working");
    await waitMsg(() => lastSummary()?.counts.working === 9 && lastSummary()?.counts.waiting === 1, "the totals of nine at work");
    assert.equal(lastSummary()?.live, 9, "the principal waiting holds no place");
    assert.equal(lastSummary()?.liveLimit, 10);
    assert.equal(latest().size, 10);

    writeFileSync(gate, "");
    await waitMsg(() => workers().filter((a) => a.state === "done").length === 9, "nine reports");
    const results = workers().flatMap((a) => (a.report ? [a.report.summary] : [])).sort();
    assert.deepEqual(results, Array.from({ length: 9 }, (_, i) => `result ${i}`).sort());
    await waitMsg(() => lastSummary()?.counts.done === 9 && lastSummary()?.counts.working === 0, "the totals");
    assert.equal(lastSummary()?.live, 0);

    // A removed agent leaves the channel.
    const someId = [...latest().keys()].find((id) => id !== roomId)!;
    assert.equal((await fetch(`${base}/rooms/${roomId}/agents/${someId}/remove`, { method: "POST" })).status, 200);
    await waitMsg(() => messages.some((m) => m.type === "room_agent_removed" && m.agentId === someId), "the removal");
    watcher.close();
  } finally {
    relay.cleanup();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
