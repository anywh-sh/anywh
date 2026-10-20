// A room's data across a restart of the relay process: the membership of
// each agent (on its session), the principal's outbox of reports, and the
// canvas sidecar — all read back by a fresh relay process from the same files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity } from "../src/agentHost/protocol.js";
import { hostEnvDir, startHostProcess } from "./helpers/agentHostProcess.js";
import { spawnRelay } from "./helpers/spawnedServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

const entry = (title: string, room?: unknown) => ({
  agentId: "claude",
  sessionId: {},
  title,
  cwd: { cwd: "/tmp", locked: false },
  lastActiveAt: Date.now(),
  ...(room !== undefined ? { room } : {}),
});

test("rooms survive a relay restart: members, reports, outbox and canvas; workers stay out of the session list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-room-persist-"));
  const sessionsFile = join(dir, "profile.json");
  const roomsFile = join(dir, "profile-rooms.json");
  const report = { status: "done", summary: "42 lines", artifacts: ["result.md"], at: 1700000000000 };
  writeFileSync(
    sessionsFile,
    JSON.stringify({
      plain: entry("Plain chat"),
      room1: entry("Release room", { roomId: "room1", role: "principal", createdBy: "user", task: "", undeliveredReports: ["w1"] }),
      w1: entry("Count lines", { roomId: "room1", role: "worker", parentId: "room1", createdBy: "agent", task: "count the lines", report }),
      broken: entry("Broken member", { roomId: "room1", role: "lead" }),
    }),
  );
  const env = { RELAY_SESSIONS_FILE: sessionsFile, RELAY_ROOMS_FILE: roomsFile };
  const canvas = { positions: { room1: { x: 0, y: 0 }, w1: { x: 300, y: 80 } }, areas: [{ id: "code", label: "Code", x: 250, y: 40, members: ["w1"] }], texts: [], camera: { x: 0, y: 0, zoom: 1 } };

  let relay = await spawnRelay(env);
  try {
    const sessions = (await (await fetch(`http://127.0.0.1:${relay.port}/sessions`)).json()) as { sessions: { id: string }[] };
    assert.deepEqual(
      sessions.sessions.map((row) => row.id).sort(),
      ["broken", "plain", "room1"],
      "the worker is not listed; the broken record became an ordinary session",
    );
    const put = await fetch(`http://127.0.0.1:${relay.port}/rooms/room1/canvas`, { method: "PUT", body: JSON.stringify({ canvas }) });
    assert.equal(put.status, 200);
    const bad = await fetch(`http://127.0.0.1:${relay.port}/rooms/room1/canvas`, { method: "PUT", body: JSON.stringify({ canvas: { positions: { w1: { x: "a" } } } }) });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${relay.port}/rooms/nope/canvas`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${relay.port}/rooms/w1`)).status, 404, "a worker's id is not a room");

    relay.proc.kill("SIGTERM");
    await relay.waitForExit();
    relay.cleanup();

    relay = await spawnRelay(env);
    const room = (await (await fetch(`http://127.0.0.1:${relay.port}/rooms/room1`)).json()) as {
      members: { id: string; title: string; room: { role: string; report?: unknown; undeliveredReports?: string[] } }[];
    };
    assert.deepEqual(
      room.members.map((member) => [member.id, member.room.role]),
      [
        ["room1", "principal"],
        ["w1", "worker"],
      ],
    );
    assert.deepEqual(room.members[0].room.undeliveredReports, ["w1"]);
    assert.deepEqual(room.members[1].room.report, report);
    const reloaded = (await (await fetch(`http://127.0.0.1:${relay.port}/rooms/room1/canvas`)).json()) as { canvas: unknown };
    assert.deepEqual(reloaded.canvas, canvas);
    const onDisk = JSON.parse(readFileSync(sessionsFile, "utf8")) as Record<string, { room?: unknown }>;
    assert.equal(onDisk.broken.room, undefined, "the malformed membership was dropped from the file");
  } finally {
    relay.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a worker in the middle of its task when the relay restarts goes on in the host, and its report reaches the new relay", async () => {
  const { dir, home } = hostEnvDir();
  const host = startHostProcess(dir, home);
  const sessionsFile = join(dir, "profile.json");
  const env = { ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_SESSIONS_FILE: sessionsFile };
  let relay = await spawnRelay(env);
  const port = String(relay.port);
  const base = (): string => `http://127.0.0.1:${relay.port}`;
  const waitFor = async (check: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!(await check().catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${relay.output.join("").slice(-2000)}\n${host.output.join("").slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const marker = (tool: string, args: unknown): string => `[[room:${tool}:${Buffer.from(JSON.stringify(args)).toString("base64url")}]]`;
  const agents = async (): Promise<AgentActivity[]> => ((await (await fetch(`${base()}/agents/activity`)).json()) as { agents: AgentActivity[] }).agents;
  try {
    await waitFor(async () => (await fetch(`${base()}/agents/activity`)).status === 200, "relay connected to the host");
    const created = (await (await fetch(`${base()}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", cwd: dir }) })).json()) as { roomId: string };
    const roomId = created.roomId;
    const gate = join(dir, "gate");
    const task = `long task [[gate:${gate}]] ${marker("report", { status: "done", summary: "finished after the restart", artifacts: [] })}`;
    const socket = await connectSession(relay.port, roomId);
    const done = collectUntil(socket, isTurnEnded, 30_000);
    sendUserMessage(socket, marker("delegate", { task, runtime: "claude", model: "haiku" }));
    await done;
    socket.close();
    let workerId = "";
    await waitFor(async () => {
      const worker = (await agents()).find((agent) => agent.roomId === roomId && agent.agentId !== roomId);
      workerId = worker?.agentId ?? "";
      return worker?.state === "working";
    }, "the worker in the middle of its task");
    const pid = (await agents()).find((agent) => agent.agentId === workerId)!.pid;

    // The relay goes down hard, mid-task, and comes back on the same port.
    relay.proc.kill("SIGKILL");
    await relay.waitForExit();
    relay.cleanup();
    relay = await spawnRelay({ ...env, RELAY_PORT: port });
    await waitFor(async () => (await agents()).some((agent) => agent.agentId === workerId), "the new relay connected to the host");
    assert.equal((await agents()).find((agent) => agent.agentId === workerId)!.pid, pid, "the same worker process kept running");

    writeFileSync(gate, "");
    await waitFor(async () => {
      const room = (await (await fetch(`${base()}/rooms/${roomId}`)).json()) as { members: { id: string; room: { report?: { summary: string }; undeliveredReports?: string[] } }[] };
      return room.members.find((member) => member.id === workerId)?.room.report?.summary === "finished after the restart";
    }, "the report through the new relay");
    const onDisk = JSON.parse(readFileSync(sessionsFile, "utf8")) as Record<string, { room?: { undeliveredReports?: string[] } }>;
    assert.deepEqual(onDisk[roomId].room?.undeliveredReports, [workerId], "persisted in the principal's outbox");
  } finally {
    relay.cleanup();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
