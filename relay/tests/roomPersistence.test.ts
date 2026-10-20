// A room's data across a restart of the relay process: the membership of
// each agent (on its session), the principal's outbox of reports, and the
// canvas sidecar — all read back by a fresh relay process from the same files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { transcriptPath } from "../src/runtimes/defs/claude/transcriptReader.js";
import { randomBytes } from "node:crypto";
import { HostClient } from "../src/agentHost/hostClient.js";
import { roomKeyPathFor, roomOwnerOf } from "../src/bridges/roomBridge.js";
import type { AgentActivity } from "../src/agentHost/protocol.js";
import { hostEnvDir, startHostProcess } from "./helpers/agentHostProcess.js";
import { spawnRelay } from "./helpers/spawnedServer.js";
import { collectUntil, connectSession, connectSessionAndCollectUntil, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

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
    let workerSession = "";
    await waitFor(async () => (workerSession = (await agents()).find((agent) => agent.agentId === workerId)?.sessionId ?? "") !== "", "the worker's session id");

    // The relay goes down hard, mid-task, and comes back on the same port.
    relay.proc.kill("SIGKILL");
    await relay.waitForExit();
    relay.cleanup();
    // What the CLI's own transcript holds of the worker's conversation so far
    // (the fake does not write one): the new relay must show it, then the
    // turn's live rest.
    const relayHome = join(dir, "relay-home");
    const transcript = transcriptPath(relayHome, dir, workerSession);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(
      transcript,
      [
        { type: "user", message: { content: "an earlier question" } },
        { type: "assistant", message: { content: [{ type: "text", text: "an earlier answer" }] } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    relay = await spawnRelay({ ...env, RELAY_PORT: port, RELAY_HOME_OVERRIDE: relayHome });
    await waitFor(async () => (await agents()).some((agent) => agent.agentId === workerId), "the new relay connected to the host");
    assert.equal((await agents()).find((agent) => agent.agentId === workerId)!.pid, pid, "the same worker process kept running");

    // The new relay picked the worker's turn up: a device opening the worker
    // sees it running, and sees it end, live.
    const { socket: watcher, messages: burst } = await connectSessionAndCollectUntil(relay.port, workerId, (message) => message.type === "caught_up", 10_000);
    const ended = collectUntil(watcher, isTurnEnded, 20_000);
    await waitFor(async () => {
      const room = (await (await fetch(`${base()}/rooms/${roomId}`)).json()) as { members: { id: string }[] };
      return room.members.some((member) => member.id === workerId);
    }, "room listed");
    const page = burst.find((message) => message.type === "history_page") as { messages: { event: { type: string; text?: string } }[] } | undefined;
    assert.ok(
      page?.messages.some((message) => message.event.type === "text" && message.event.text === "an earlier answer"),
      `the conversation before the restart is shown: ${JSON.stringify(page?.messages.map((message) => message.event.type))}`,
    );
    assert.ok(
      burst.some((message) => message.type === "turn_state" && message.active === true),
      `the turn in flight shows as running after the restart: ${JSON.stringify(burst.filter((message) => message.type === "turn_state"))}`,
    );
    writeFileSync(gate, "");
    const tail = await ended;
    watcher.close();
    assert.ok(
      tail.some((message) => message.type === "agent_event" && (message.event as { type?: string; name?: string }).type === "tool_started" && (message.event as { name?: string }).name === "mcp__anywh-room__report"),
      "the rest of the turn streamed live",
    );
    await waitFor(async () => {
      const room = (await (await fetch(`${base()}/rooms/${roomId}`)).json()) as { members: { id: string; room: { report?: { summary: string }; undeliveredReports?: string[] } }[] };
      return room.members.find((member) => member.id === workerId)?.room.report?.summary === "finished after the restart";
    }, "the report through the new relay");
    const onDisk = JSON.parse(readFileSync(sessionsFile, "utf8")) as Record<string, { room?: { undeliveredReports?: string[] } }>;
    assert.deepEqual(onDisk[roomId].room?.undeliveredReports, [workerId], "persisted in the principal's outbox");
    const cursorsFile = join(dir, "profile-room-cursors.json");
    await waitFor(() => Promise.resolve().then(() => workerId in (JSON.parse(readFileSync(cursorsFile, "utf8")) as Record<string, unknown>)), "the worker's read cursor kept");
    assert.equal((await fetch(`${base()}/sessions/delete`, { method: "POST", body: JSON.stringify({ id: workerId }) })).status, 200);
    assert.equal(workerId in (JSON.parse(readFileSync(cursorsFile, "utf8")) as Record<string, unknown>), false, "and dropped with the agent");
  } finally {
    relay.cleanup();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on connecting to its host the relay delivers messages queued before a restart, and removes the room agents it no longer has", async () => {
  const { dir, home } = hostEnvDir();
  const host = startHostProcess(dir, home);
  const sessionsFile = join(dir, "profile.json");
  const control = new HostClient({ socketPath: host.socketPath, reconnectMinMs: 20, reconnectMaxMs: 200 });
  let relay: Awaited<ReturnType<typeof spawnRelay>> | undefined;
  try {
    control.start();
    await control.waitUntilConnected(15_000);
    // This relay's identity, as its key file (beside its sessions file) makes it.
    const key = randomBytes(32);
    writeFileSync(roomKeyPathFor(sessionsFile), key, { mode: 0o600 });
    await control.request("spawn", { agentId: "orphan1", roomId: "ghost-room", owner: roomOwnerOf(key), spec: { cwd: dir }, message: "left behind" });
    await control.request("spawn", { agentId: "plain1", spec: { cwd: dir }, message: "not a room's" });
    writeFileSync(
      sessionsFile,
      JSON.stringify({
        room9: entry("Room", { roomId: "room9", role: "principal", createdBy: "user", task: "", undeliveredReports: [] }),
        w9: { ...entry("Queued worker", { roomId: "room9", role: "worker", parentId: "room9", createdBy: "agent", task: "t", queuedMessages: [{ text: "queued before the restart", at: 1 }] }), cwd: { cwd: dir, locked: false } },
      }),
    );
    relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_SESSIONS_FILE: sessionsFile });
    const agents = async (): Promise<AgentActivity[]> => (await control.request<{ agents: AgentActivity[] }>("activity")).agents;
    const deadline = Date.now() + 20_000;
    for (;;) {
      const now = await agents();
      const worker = now.find((agent) => agent.agentId === "w9");
      if (worker?.state === "idle" && !now.some((agent) => agent.agentId === "orphan1")) break;
      if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(now)}\n${relay.output.join("").slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const now = await agents();
    assert.ok(now.some((agent) => agent.agentId === "plain1"), "an agent of no room is not the rooms' business");
    const onDisk = JSON.parse(readFileSync(sessionsFile, "utf8")) as Record<string, { room?: { queuedMessages?: unknown[] } }>;
    assert.equal(onDisk.w9.room?.queuedMessages, undefined, "delivered, so no longer queued");
  } finally {
    control.close();
    relay?.cleanup();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with its host down a worker's queue stays on disk, untouched, and goes out once the host is back", async () => {
  const { dir, home } = hostEnvDir();
  const socketPath = join(dir, "run", "host.sock");
  const sessionsFile = join(dir, "profile.json");
  writeFileSync(
    sessionsFile,
    JSON.stringify({
      room7: entry("Room", { roomId: "room7", role: "principal", createdBy: "user", task: "", undeliveredReports: [] }),
      w7: {
        ...entry("Worker", { roomId: "room7", role: "worker", parentId: "room7", createdBy: "agent", task: "t", queuedMessages: [{ text: "first", at: 1 }, { text: "second", at: 2 }] }),
        cwd: { cwd: dir, locked: false },
      },
    }),
  );
  const queued = (): string[] => ((JSON.parse(readFileSync(sessionsFile, "utf8")) as Record<string, { room?: { queuedMessages?: { text: string }[] } }>).w7.room?.queuedMessages ?? []).map((m) => m.text);
  const relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: socketPath, RELAY_SESSIONS_FILE: sessionsFile });
  let host: ReturnType<typeof startHostProcess> | undefined;
  try {
    // A turn typed into the worker while the host is down fails...
    const socket = await connectSession(relay.port, "w7");
    const failed = collectUntil(socket, (message) => message.type === "agent_event" && (message.event as { type?: string }).type === "error", 20_000);
    sendUserMessage(socket, "are you there?");
    await failed;
    socket.close();
    // ...and takes nothing from the queue with it.
    assert.deepEqual(queued(), ["first", "second"]);

    host = startHostProcess(dir, home);
    const deadline = Date.now() + 25_000;
    while (queued().length > 0) {
      if (Date.now() > deadline) throw new Error(`queue not delivered: ${JSON.stringify(queued())}\n${relay.output.join("").slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const control = new HostClient({ socketPath, reconnectMinMs: 20, reconnectMaxMs: 200 });
    control.start();
    await control.waitUntilConnected(10_000);
    const log: string[] = [];
    control.subscribe("w7", { nextOffset: 0, lastSeq: -1 }, { onEvent: (record) => { if (record.ev.type === "host_user_message") log.push(String(record.ev.text)); } });
    const until = Date.now() + 15_000;
    while (log.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    control.close();
    assert.deepEqual(log, ["first", "second"], "each delivered once, in order");
  } finally {
    relay.cleanup();
    await host?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the relay removes only its own room agents, and never when its sessions file cannot be trusted", async () => {
  const { dir, home } = hostEnvDir();
  const host = startHostProcess(dir, home);
  const control = new HostClient({ socketPath: host.socketPath, reconnectMinMs: 20, reconnectMaxMs: 200 });
  const relays: Awaited<ReturnType<typeof spawnRelay>>[] = [];
  const ids = async (): Promise<string[]> => (await control.request<{ agents: AgentActivity[] }>("activity")).agents.map((agent) => agent.agentId).sort();
  const reconciled = async (relay: Awaited<ReturnType<typeof spawnRelay>>): Promise<void> => {
    // The reconciliation runs on connecting; this waits for that connection,
    // then for one more round trip through the relay.
    const deadline = Date.now() + 15_000;
    while ((await fetch(`http://127.0.0.1:${relay.port}/agents/activity`).catch(() => undefined))?.status !== 200) {
      if (Date.now() > deadline) throw new Error("relay never connected");
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 500));
  };
  try {
    control.start();
    await control.waitUntilConnected(15_000);
    const sessionsFile = join(dir, "mine.json");
    const key = randomBytes(32);
    writeFileSync(roomKeyPathFor(sessionsFile), key, { mode: 0o600 });
    const mine = roomOwnerOf(key);
    // (a) A room agent of another relay on the same host.
    await control.request("spawn", { agentId: "theirs", roomId: "their-room", owner: "someone-else", spec: { cwd: dir } });
    // (c) Ours, with a record whose room this release cannot read.
    await control.request("spawn", { agentId: "rolled-back", roomId: "r1", owner: mine, spec: { cwd: dir } });
    // (b) Ours, with no record at all — while the sessions file is unreadable.
    await control.request("spawn", { agentId: "unknown", roomId: "r2", owner: mine, spec: { cwd: dir } });
    writeFileSync(sessionsFile, "{ this is not json");
    let relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_SESSIONS_FILE: sessionsFile });
    relays.push(relay);
    await reconciled(relay);
    assert.deepEqual(await ids(), ["rolled-back", "theirs", "unknown"], "nothing removed with an unreadable sessions file");
    assert.ok(readdirSync(dir).some((name) => name.startsWith("mine.json.corrupt-")), "the unreadable file was kept aside");
    relay.cleanup();

    writeFileSync(sessionsFile, JSON.stringify({ "rolled-back": { ...entry("Kept", { roomId: "r1", role: "a-role-from-the-future" }) } }));
    relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_SESSIONS_FILE: sessionsFile });
    relays.push(relay);
    const deadline = Date.now() + 15_000;
    while ((await ids()).includes("unknown")) {
      if (Date.now() > deadline) throw new Error(`our orphan was not removed: ${JSON.stringify(await ids())}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(await ids(), ["rolled-back", "theirs"], "only ours with no record went; another relay's and a record we cannot read stay");
  } finally {
    control.close();
    for (const relay of relays) relay.cleanup();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
