// How the reports of a room's agents reach the agent that started them,
// across real processes (the agent host running the fake `claude`, and the
// real relay): N reports make at most one turn of the principal, a failure or
// a block wakes it at once, a report goes to the closest live ancestor, and a
// digest the principal answers with NO_REPLY leaves no trace in its chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type WebSocket from "ws";
import { hostEnvDir, startHostProcess, type HostProcess } from "./helpers/agentHostProcess.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { collectUntil, connectSession, connectSessionAndCollectUntil, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

const WINDOW_MS = 250;

interface Stack {
  host: HostProcess;
  relay: SpawnedServer;
  base: string;
  dir: string;
}

async function startStack(hostEnv: Record<string, string> = {}, sessionsFile?: string): Promise<Stack> {
  const { dir, home } = hostEnvDir();
  const host = startHostProcess(dir, home, hostEnv);
  const relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_ROOM_DIGEST_WINDOW_MS: String(WINDOW_MS), ...(sessionsFile ? { RELAY_SESSIONS_FILE: sessionsFile } : {}) });
  const base = `http://127.0.0.1:${relay.port}`;
  const stack = { host, relay, base, dir };
  await waitFor(stack, async () => (await fetch(`${base}/agents/activity`)).status === 200, 20_000, "relay connected to the host");
  return stack;
}

async function stopStack(stack: Stack): Promise<void> {
  stack.relay.cleanup();
  await stack.host.stop();
  rmSync(stack.dir, { recursive: true, force: true });
}

async function waitFor(stack: Stack, check: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await Promise.resolve(check()).catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${stack.relay.output.join("").slice(-3000)}\n${stack.host.output.join("").slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const marker = (tool: string, args: unknown): string => `[[room:${tool}:${Buffer.from(JSON.stringify(args)).toString("base64url")}]]`;

interface Member {
  id: string;
  room: { role: string; parentId?: string; report?: { status: string; summary: string }; undeliveredReports?: string[]; stopped?: { reason: string } };
}

async function members(stack: Stack, roomId: string): Promise<Member[]> {
  return ((await (await fetch(`${stack.base}/rooms/${roomId}`)).json()) as { members: Member[] }).members;
}

async function createRoom(stack: Stack): Promise<string> {
  const res = await fetch(`${stack.base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", cwd: stack.dir, title: "Digest room" }) });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { roomId: string }).roomId;
}

/** One principal turn that makes the calls the text names, and returns the
 * `agentId` of the first `delegate` among them. */
async function delegateVia(socket: WebSocket, ...args: unknown[]): Promise<string[]> {
  const done = collectUntil(socket, isTurnEnded, 30_000);
  sendUserMessage(socket, args.map((a) => marker("delegate", a)).join(" "));
  const messages = await done;
  return messages
    .filter((message) => message.type === "agent_event" && (message.event as { type?: string }).type === "tool_ended")
    .map((message) => (JSON.parse(String((message.event as { content?: unknown }).content)) as { agentId: string }).agentId);
}

/** Every digest turn a session announced to its clients, as its text. */
function digestsIn(messages: Record<string, unknown>[]): string[] {
  return messages
    .filter((message) => message.type === "agent_event")
    .map((message) => message.event as { type?: string; synthetic?: string; text?: string })
    .filter((event) => event.type === "user_message" && event.synthetic === "room_digest")
    .map((event) => event.text ?? "");
}

/** Keeps every message a session sends from now on. */
function record(socket: WebSocket): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  socket.on("message", (raw: Buffer) => seen.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  return seen;
}

const taskWith = (gate: string, report: unknown): string => `work [[gate:${gate}]] ${marker("report", report)}`;

test("N reports make one turn of the principal, sent when the last agent under it is done", async () => {
  const stack = await startStack();
  try {
    const roomId = await createRoom(stack);
    const socket = await connectSession(stack.relay.port, roomId);
    const seen = record(socket);
    const gates = [1, 2, 3].map((n) => join(stack.dir, `gate-${n}`));
    const ids = await delegateVia(
      socket,
      ...gates.map((gate, index) => ({ task: taskWith(gate, { status: "done", summary: `result ${index + 1}`, artifacts: [`out-${index + 1}.md`] }), runtime: "claude", model: "haiku" })),
    );
    assert.equal(ids.length, 3);
    await waitFor(stack, async () => (await members(stack, roomId)).filter((m) => m.room.role === "worker").length === 3);

    // Two of three finish: the principal is not woken for them.
    writeFileSync(gates[0], "");
    writeFileSync(gates[1], "");
    await waitFor(stack, async () => (await members(stack, roomId)).find((m) => m.id === ids[1])?.room.report !== undefined, 20_000, "two reports");
    await sleep(WINDOW_MS * 4);
    assert.deepEqual(digestsIn(seen), [], "nothing for the principal while one agent still works");
    const waiting = (await members(stack, roomId)).find((m) => m.id === roomId)!;
    assert.equal(waiting.room.undeliveredReports?.length, 2, "the two reports wait in the outbox");

    // The last one finishes: one turn, with all three reports.
    writeFileSync(gates[2], "");
    await waitFor(stack, () => digestsIn(seen).length > 0, 20_000, "the digest");
    await sleep(WINDOW_MS * 4);
    const digests = digestsIn(seen);
    assert.equal(digests.length, 1, `exactly one digest turn: ${JSON.stringify(digests)}`);
    for (const text of ["result 1", "result 2", "result 3", "out-2.md", ...ids]) assert.ok(digests[0].includes(text), `the digest has ${text}`);
    assert.ok(digests[0].startsWith("[anywh-room]"));
    await waitFor(stack, async () => ((await members(stack, roomId)).find((m) => m.id === roomId)!.room.undeliveredReports ?? []).length === 0, 10_000, "the outbox emptied");
    socket.close();

    // Replayed from the principal's transcript-less log on a new connection: still one.
    const { socket: again, messages } = await connectSessionAndCollectUntil(stack.relay.port, roomId, (m) => m.type === "caught_up", 10_000);
    again.close();
    const page = messages.find((m) => m.type === "history_page") as { messages: Record<string, unknown>[] } | undefined;
    assert.equal(digestsIn(page?.messages ?? []).length, 1);
  } finally {
    await stopStack(stack);
  }
});

test("a failed or blocked report wakes the principal at once, without waiting for the rest; the next round is a new digest", async () => {
  const stack = await startStack();
  try {
    const roomId = await createRoom(stack);
    const socket = await connectSession(stack.relay.port, roomId);
    const seen = record(socket);
    const slow = join(stack.dir, "gate-slow");
    const [failing, slowOne] = await delegateVia(
      socket,
      { task: `work ${marker("report", { status: "failed", summary: "the build broke", artifacts: [] })}`, runtime: "claude", model: "haiku" },
      { task: taskWith(slow, { status: "done", summary: "slow result", artifacts: [] }), runtime: "claude", model: "haiku" },
    );
    await waitFor(stack, () => digestsIn(seen).length > 0, 20_000, "the digest for the failure");
    let digests = digestsIn(seen);
    assert.equal(digests.length, 1);
    assert.ok(digests[0].includes("the build broke") && digests[0].includes(failing));
    assert.ok(!digests[0].includes("slow result"));
    assert.match(digests[0], /1 more agent is still working/);
    assert.match(digests[0], /failed or is blocked/);

    writeFileSync(slow, "");
    await waitFor(stack, () => digestsIn(seen).length > 1, 20_000, "the next round's digest");
    await sleep(WINDOW_MS * 4);
    digests = digestsIn(seen);
    assert.equal(digests.length, 2, "one digest per round");
    assert.ok(digests[1].includes("slow result") && digests[1].includes(slowOne));
    assert.ok(!digests[1].includes("the build broke"), "what was handed over is not handed over again");
    socket.close();
  } finally {
    await stopStack(stack);
  }
});

test("a report goes to the closest live ancestor; when that agent is stopped, to the one above it", async () => {
  const stack = await startStack();
  try {
    const roomId = await createRoom(stack);
    const principal = await connectSession(stack.relay.port, roomId);
    const seenPrincipal = record(principal);
    const gateParent = join(stack.dir, "gate-parent");
    const gateChild = join(stack.dir, "gate-child");
    const gateOrphan = join(stack.dir, "gate-orphan");
    const [parentId] = await delegateVia(principal, { task: taskWith(gateParent, { status: "done", summary: "parent done", artifacts: [] }), runtime: "claude", model: "haiku" });
    const [childId] = await delegateVia(principal, { task: taskWith(gateChild, { status: "done", summary: "child result", artifacts: [] }), runtime: "claude", model: "haiku", parentId });
    const parent = await connectSession(stack.relay.port, parentId);
    const seenParent = record(parent);

    // The child reports to its parent, not to the principal.
    writeFileSync(gateChild, "");
    await waitFor(stack, async () => ((await members(stack, roomId)).find((m) => m.id === parentId)!.room.undeliveredReports ?? []).includes(childId), 20_000, "the child's report in its parent's outbox");
    assert.deepEqual((await members(stack, roomId)).find((m) => m.id === roomId)!.room.undeliveredReports ?? [], [], "not in the principal's");

    // The parent, busy with its own task, gets the digest as its next turn.
    writeFileSync(gateParent, "");
    await waitFor(stack, () => digestsIn(seenParent).length > 0, 20_000, "the digest reaching the parent");
    assert.ok(digestsIn(seenParent)[0].includes("child result"));
    // Its own report goes to the principal, without the child's.
    await waitFor(stack, () => digestsIn(seenPrincipal).length > 0, 20_000, "the parent's report reaching the principal");
    assert.ok(digestsIn(seenPrincipal)[0].includes("parent done"));
    assert.ok(!digestsIn(seenPrincipal)[0].includes("child result"));

    // Another child whose parent is stopped before it reports: the principal gets it.
    const [orphanId] = await delegateVia(principal, { task: taskWith(gateOrphan, { status: "done", summary: "orphan result", artifacts: [] }), runtime: "claude", model: "haiku", parentId });
    assert.equal((await fetch(`${stack.base}/rooms/${roomId}/agents/${parentId}/stop`, { method: "POST" })).status, 200);
    writeFileSync(gateOrphan, "");
    await waitFor(stack, () => digestsIn(seenPrincipal).length > 1, 20_000, "the orphan's report reaching the principal");
    const text = digestsIn(seenPrincipal)[1];
    assert.ok(text.includes("orphan result") && text.includes(orphanId));
    assert.equal(digestsIn(seenParent).length, 1, "the stopped parent is told nothing more");
    principal.close();
    parent.close();
  } finally {
    await stopStack(stack);
  }
});

test("a digest the principal answers with NO_REPLY leaves nothing in its chat, and counts as handed over", async () => {
  const stack = await startStack({ FAKE_CLAUDE_DIGEST_REPLY: "NO_REPLY" });
  try {
    const roomId = await createRoom(stack);
    const socket = await connectSession(stack.relay.port, roomId);
    const seen = record(socket);
    await delegateVia(socket, { task: `work ${marker("report", { status: "done", summary: "quiet result", artifacts: [] })}`, runtime: "claude", model: "haiku" });
    await waitFor(stack, async () => {
      const principal = (await members(stack, roomId)).find((m) => m.id === roomId)!;
      return (principal.room.undeliveredReports ?? []).length === 0 && (await members(stack, roomId)).some((m) => m.room.report !== undefined);
    }, 20_000, "the digest to be handed over");
    await sleep(WINDOW_MS * 4);
    assert.deepEqual(digestsIn(seen), [], "no digest bubble");
    const afterDelegation = seen.filter((m) => isTurnEnded(m)).length;
    assert.equal(afterDelegation, 1, "only the delegation turn is shown, not the digest's");
    socket.close();
    const { socket: again, messages } = await connectSessionAndCollectUntil(stack.relay.port, roomId, (m) => m.type === "caught_up", 10_000);
    again.close();
    const page = messages.find((m) => m.type === "history_page") as { messages: Record<string, unknown>[] } | undefined;
    assert.deepEqual(digestsIn(page?.messages ?? []), []);
  } finally {
    await stopStack(stack);
  }
});

test("reports left in an outbox before a restart are handed over once the host is connected", async () => {
  const { dir, home } = hostEnvDir();
  const sessionsFile = join(dir, "profile.json");
  const entry = (title: string, room: unknown) => ({ agentId: "claude", sessionId: {}, title, cwd: { cwd: dir, locked: false }, lastActiveAt: Date.now(), room });
  writeFileSync(
    sessionsFile,
    JSON.stringify({
      r1: entry("Room", { roomId: "r1", role: "principal", createdBy: "user", task: "", undeliveredReports: ["w1", "ghost"] }),
      w1: entry("Left over", { roomId: "r1", role: "worker", parentId: "r1", createdBy: "agent", task: "t", report: { status: "done", summary: "found after the restart", artifacts: [], at: 5 } }),
    }),
  );
  const host = startHostProcess(dir, home);
  const stack: Stack = { host, relay: undefined as unknown as SpawnedServer, base: "", dir };
  try {
    stack.relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_ROOM_DIGEST_WINDOW_MS: String(WINDOW_MS), RELAY_SESSIONS_FILE: sessionsFile });
    stack.base = `http://127.0.0.1:${stack.relay.port}`;
    await waitFor(stack, () => {
      const records = JSON.parse(readFileSync(sessionsFile, "utf8")) as Record<string, { room?: { undeliveredReports?: string[] } }>;
      return (records.r1.room?.undeliveredReports ?? []).length === 0;
    }, 20_000, "the left-over report to be handed over");
    // The turn's events are held back from the log until it shows it is not silent.
    let digests: string[] = [];
    await waitFor(stack, async () => {
      const { socket, messages } = await connectSessionAndCollectUntil(stack.relay.port, "r1", (m) => m.type === "caught_up", 10_000);
      socket.close();
      digests = digestsIn((messages.find((m) => m.type === "history_page") as { messages: Record<string, unknown>[] } | undefined)?.messages ?? []);
      return digests.length > 0;
    }, 10_000, "the digest in the principal's chat");
    assert.equal(digests.length, 1);
    assert.ok(digests[0].includes("found after the restart"));
    assert.ok(existsSync(sessionsFile));
  } finally {
    stack.relay?.cleanup();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
