// A room worker's tool call that needs approval, across real processes (the
// agent host running the fake `claude` with a `--permission-prompt-tool`, and
// the real relay): the call is refused at once and the worker's turn ends
// instead of holding a permission call open; the worker is waiting for the
// person (not blocked, nothing reported); once the person approves, the next
// turn repeats the call and it runs; a denial never runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { hostEnvDir, startHostProcess } from "./helpers/agentHostProcess.js";
import { spawnRelay } from "./helpers/spawnedServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

const marker = (tool: string, args: unknown): string => `[[room:${tool}:${Buffer.from(JSON.stringify(args)).toString("base64url")}]]`;
const ask = (call: unknown): string => `[[ask:${Buffer.from(JSON.stringify(call)).toString("base64url")}]]`;

interface AgentView {
  agentId: string;
  role: string;
  state: string;
  report?: { status: string; summary: string };
  needsYou: { kind: string; promptId: string; count: number }[];
}

test("a worker's tool call becomes an approval card and its turn ends; approving runs it in the next turn, denying never does", async () => {
  const { dir, home } = hostEnvDir();
  const host = startHostProcess(dir, home);
  const relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath });
  const base = `http://127.0.0.1:${relay.port}`;
  const sockets: WebSocket[] = [];
  try {
    const deadline = Date.now() + 30_000;
    while ((await fetch(`${base}/agents/activity`).catch(() => ({ status: 0 }))).status !== 200) {
      if (Date.now() > deadline) throw new Error("host not connected");
      await new Promise((r) => setTimeout(r, 25));
    }
    const created = (await (await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", permissionMode: "default", cwd: dir }) })).json()) as { roomId: string };
    const roomId = created.roomId;

    const agents = new Map<string, AgentView>();
    const watcher = new WebSocket(`ws://127.0.0.1:${relay.port}/rooms/${roomId}/watch`);
    sockets.push(watcher);
    watcher.on("message", (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as { type: string; agents?: AgentView[]; agent?: AgentView };
      if (message.type === "room_snapshot") for (const agent of message.agents ?? []) agents.set(agent.agentId, agent);
      if (message.type === "room_agent_state" && message.agent) agents.set(message.agent.agentId, message.agent);
    });
    await new Promise<void>((resolve, reject) => {
      watcher.once("open", () => resolve());
      watcher.once("error", reject);
    });
    const waitFor = async (check: () => boolean, what: string): Promise<void> => {
      for (const end = Date.now() + 30_000; !check(); ) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify([...agents.values()])}\n${relay.output.join("").slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const worker = (index: number): AgentView | undefined => [...agents.values()].filter((agent) => agent.role === "worker")[index];

    const approved = join(dir, "approved.txt");
    const denied = join(dir, "denied.txt");
    const principal = await connectSession(relay.port, roomId);
    sockets.push(principal);
    const delegated = collectUntil(principal, isTurnEnded, 30_000);
    sendUserMessage(
      principal,
      [approved, denied]
        .map((file) => marker("delegate", { task: `write it ${ask({ tool: "Write", input: { file_path: file, content: "x" } })}`, runtime: "claude", model: "haiku" }))
        .join(" "),
    );
    await delegated;

    // Both workers end their turn at the card: waiting for the person, not
    // blocked, nothing reported, and the file not written.
    await waitFor(() => agents.size === 3 && [0, 1].every((i) => worker(i)?.state === "awaiting_user" && worker(i)?.needsYou[0]?.kind === "approval"), "two approvals waiting");
    assert.ok(!existsSync(approved) && !existsSync(denied));
    assert.ok([0, 1].every((i) => worker(i)?.report === undefined), "an agent waiting for the person has not reported");

    // The workers are told apart by the file their card is about.
    const answerCard = async (agentId: string, selected: string): Promise<{ file: string }> => {
      const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/?session=${encodeURIComponent(agentId)}`);
      sockets.push(socket);
      const cardPromise = new Promise<{ promptId: string; questions: { question: string }[] }>((resolve, reject) => {
        socket.on("message", (raw: Buffer) => {
          const message = JSON.parse(raw.toString()) as { type: string; promptId: string; questions: { question: string }[] };
          if (message.type === "choice_prompt") resolve(message);
        });
        socket.once("error", reject);
      });
      await new Promise<void>((resolve) => socket.once("open", () => resolve()));
      const card = await cardPromise;
      const file = /approved\.txt/.test(JSON.stringify(card.questions)) ? approved : denied;
      socket.send(JSON.stringify({ type: "choice_answer", promptId: card.promptId, answers: card.questions.map((q) => ({ question: q.question, selected: [selected] })) }));
      return { file };
    };
    const ids = [...agents.values()].filter((agent) => agent.role === "worker").map((agent) => agent.agentId);
    const first = await answerCard(ids[0], "approve");
    const second = await answerCard(ids[1], "deny");
    const byFile = new Map<string, string>([
      [first.file, ids[0]],
      [second.file, ids[1]],
    ]);
    // The approved worker runs the call and reports; the denied one never
    // does and is not asked again.
    await waitFor(() => agents.get(byFile.get(approved) ?? "")?.report?.status === "done", "the approved worker's report");
    assert.ok(existsSync(approved), "the approved call ran");
    assert.ok(!existsSync(denied), "the denied call never ran");
    await waitFor(() => agents.get(byFile.get(denied) ?? "")?.report?.status === "blocked", "the denied worker's report");
    assert.equal(agents.get(byFile.get(denied) ?? "")?.needsYou.length, 0, "the denied card is closed, not asked again");
    assert.ok(!existsSync(denied), "the denied call never ran");
  } finally {
    for (const socket of sockets) socket.close();
    relay.cleanup();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agents of a room asking together make one notification, about the room, and none for each worker", async () => {
  const { dir, home } = hostEnvDir();
  const host = startHostProcess(dir, home);
  const pushed: { event: { kind: string; sessionId: string; title: string | null; preview: string | null } }[] = [];
  const gateway = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      pushed.push(JSON.parse(raw) as (typeof pushed)[number]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ rejected: [], failed: [] }));
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_PUSH_DEVICES_FILE: join(dir, "push-devices.json"), RELAY_ROOM_PROMPT_WINDOW_MS: "4000" });
  const base = `http://127.0.0.1:${relay.port}`;
  const sockets: WebSocket[] = [];
  try {
    const deadline = Date.now() + 30_000;
    while ((await fetch(`${base}/agents/activity`).catch(() => ({ status: 0 }))).status !== 200) {
      if (Date.now() > deadline) throw new Error("host not connected");
      await new Promise((r) => setTimeout(r, 25));
    }
    const registered = await fetch(`${base}/push/devices/3f2b1c9e-4d5a-4b6c-8d7e-9f0a1b2c3d4e`, {
      method: "PUT",
      body: JSON.stringify({ gatewayUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/push/v1/notify`, pushKey: "key-1", data: { profileId: "p" } }),
    });
    assert.equal(registered.status, 204);
    const created = (await (await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", permissionMode: "default", cwd: dir, title: "Release room" }) })).json()) as { roomId: string };
    const principal = await connectSession(relay.port, created.roomId);
    sockets.push(principal);
    const delegated = collectUntil(principal, isTurnEnded, 30_000);
    sendUserMessage(
      principal,
      [1, 2, 3]
        .map((n) => marker("delegate", { task: `write ${ask({ tool: "Write", input: { file_path: join(dir, `f${n}.txt`), content: "x" } })}`, runtime: "claude", model: "haiku" }))
        .join(" "),
    );
    await delegated;
    // The three workers' cards make one notification about the room.
    for (const end = Date.now() + 20_000; !pushed.some((p) => p.event.kind === "approval_required"); ) {
      if (Date.now() > end) throw new Error(`no approval notification; saw ${JSON.stringify(pushed)}\n${relay.output.join("").slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 1500));
    const prompts = pushed.filter((p) => ["approval_required", "choice_required"].includes(p.event.kind));
    assert.equal(prompts.length, 1, JSON.stringify(pushed));
    assert.equal(prompts[0].event.sessionId, created.roomId);
    assert.equal(prompts[0].event.title, "Release room");
    assert.equal(prompts[0].event.preview, "3 agents are waiting for you");
  } finally {
    for (const socket of sockets) socket.close();
    relay.cleanup();
    await host.stop();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("answering a card is refused while the room is full, and the card stays open; once a place frees up the same answer works", async () => {
  const { dir, home } = hostEnvDir();
  // The host's own limit on live processes is not what is tested here.
  const host = startHostProcess(dir, home, { ANYWH_AGENT_HOST_MAX_ALIVE_PER_ROOM: "20" });
  const relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath });
  const base = `http://127.0.0.1:${relay.port}`;
  const sockets: WebSocket[] = [];
  try {
    const deadline = Date.now() + 30_000;
    while ((await fetch(`${base}/agents/activity`).catch(() => ({ status: 0 }))).status !== 200) {
      if (Date.now() > deadline) throw new Error("host not connected");
      await new Promise((r) => setTimeout(r, 25));
    }
    const created = (await (await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", permissionMode: "default", cwd: dir }) })).json()) as { roomId: string };
    const roomId = created.roomId;

    const agents = new Map<string, AgentView>();
    let live = 0;
    const watcher = new WebSocket(`ws://127.0.0.1:${relay.port}/rooms/${roomId}/watch`);
    sockets.push(watcher);
    watcher.on("message", (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as { type: string; agents?: AgentView[]; agent?: AgentView; summary?: { live: number } };
      if (message.type === "room_snapshot") for (const agent of message.agents ?? []) agents.set(agent.agentId, agent);
      if (message.type === "room_agent_state" && message.agent) agents.set(message.agent.agentId, message.agent);
      if (message.summary) live = message.summary.live;
    });
    await new Promise<void>((resolve, reject) => {
      watcher.once("open", () => resolve());
      watcher.once("error", reject);
    });
    const waitFor = async (check: () => boolean, what: string): Promise<void> => {
      for (const end = Date.now() + 30_000; !check(); ) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}: live=${live} ${JSON.stringify([...agents.values()])}\n${relay.output.join("").slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    // One worker ends its turn at an approval card: it takes no place.
    const written = join(dir, "written.txt");
    const principal = await connectSession(relay.port, roomId);
    sockets.push(principal);
    let turn = collectUntil(principal, isTurnEnded, 30_000);
    sendUserMessage(principal, marker("delegate", { task: `write it ${ask({ tool: "Write", input: { file_path: written, content: "x" } })}`, runtime: "claude", model: "haiku" }));
    await turn;
    await waitFor(() => [...agents.values()].some((agent) => agent.role === "worker" && agent.state === "awaiting_user"), "the approval card");
    const asking = [...agents.values()].find((agent) => agent.role === "worker")!;

    // Meanwhile nine others fill the room (the principal's own turn takes the tenth place).
    turn = collectUntil(principal, isTurnEnded, 30_000);
    sendUserMessage(principal, Array.from({ length: 9 }, (_, index) => marker("delegate", { task: `busy ${index} [[hang]]`, runtime: "claude", model: "haiku" })).join(" "));
    await turn;
    await waitFor(() => live === 9, "nine agents at work");
    sendUserMessage(principal, "stay busy [[hang]]");
    await waitFor(() => live === 10, "a full room");

    const card = new WebSocket(`ws://127.0.0.1:${relay.port}/?session=${encodeURIComponent(asking.agentId)}`);
    sockets.push(card);
    type Received = { type: string; promptId?: string; code?: string; questions?: { question: string }[] };
    const received: Received[] = [];
    card.on("message", (raw: Buffer) => received.push(JSON.parse(raw.toString()) as Received));
    await new Promise<void>((resolve) => card.once("open", () => resolve()));
    await waitFor(() => received.some((message) => message.type === "choice_prompt"), "the card on its session");
    const prompt = received.find((message) => message.type === "choice_prompt")!;
    const answer = (): void => card.send(JSON.stringify({ type: "choice_answer", promptId: prompt.promptId, answers: prompt.questions!.map((q) => ({ question: q.question, selected: ["approve"] })) }));

    // Refused with the code, and the card is sent again for the device to show.
    const before = received.length;
    answer();
    await waitFor(() => received.some((message) => message.type === "choice_answer_error"), "the refusal");
    const refusal = received.find((message) => message.type === "choice_answer_error")!;
    assert.equal(refusal.code, "room_cap_reached");
    assert.equal(refusal.promptId, prompt.promptId);
    await waitFor(() => received.slice(before).some((message) => message.type === "choice_prompt" && message.promptId === prompt.promptId), "the card sent again");
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!existsSync(written), "the call did not run");
    assert.ok(!received.some((message) => message.type === "choice_resolved"), "the card was not resolved");
    assert.equal(agents.get(asking.agentId)?.state, "awaiting_user");
    assert.equal(agents.get(asking.agentId)?.needsYou.length, 1, "the card is still open");

    // A place frees up: the same card is answered and the call runs.
    const busy = [...agents.values()].find((agent) => agent.role === "worker" && agent.agentId !== asking.agentId)!;
    assert.equal((await fetch(`${base}/rooms/${roomId}/agents/${busy.agentId}/stop`, { method: "POST" })).status, 200);
    await waitFor(() => live === 9, "a free place");
    answer();
    await waitFor(() => agents.get(asking.agentId)?.report?.status === "done", "the worker's report");
    assert.ok(existsSync(written), "the approved call ran");
  } finally {
    for (const socket of sockets) socket.close();
    relay.cleanup();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
