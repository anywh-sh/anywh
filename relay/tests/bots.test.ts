// Bots end to end, across real processes: the agent host running the fake
// `claude`, the real relay serving the room bridge (where a bot's own tools
// live) and its HTTP routes. The fake calls the bridge exactly where the
// real CLI would, scripted by markers in the message text
// (fake-claude-persistent.mjs).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type WebSocket from "ws";
import { hostEnvDir, startHostProcess, type HostProcess } from "./helpers/agentHostProcess.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { collectUntil, connectSession, connectSessionListWatch, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

let host: HostProcess;
let relay: SpawnedServer;
let base: string;

before(async () => {
  const { dir, home } = hostEnvDir();
  host = startHostProcess(dir, home);
  // Reports reach the bot at once, so a worker's round ends inside a test.
  relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_WORKTREES_ROOT: join(dir, "worktrees"), RELAY_ROOM_DIGEST_WINDOW_MS: "50" });
  base = `http://127.0.0.1:${relay.port}`;
  await waitFor(async () => (await fetch(`${base}/agents/activity`)).status === 200, 20_000, "relay connected to the host");
});

after(async () => {
  relay?.cleanup();
  await host?.stop();
  if (host) rmSync(host.dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${relay?.output.join("").slice(-3000) ?? ""}\n${host?.output.join("").slice(-3000) ?? ""}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const marker = (tool: string, args: unknown): string => `[[room:${tool}:${Buffer.from(JSON.stringify(args)).toString("base64url")}]]`;

interface BotView {
  id: string;
  roomId: string;
  name: string;
  needsYou: number;
  firstRun: boolean;
  lastRunFailed: boolean;
  limitedUntil?: number;
  mascot: { character: string; tone: string };
  tasks: { n: number; title: string; status: string; question?: { question: string; options: string[] }; workers: { agentId: string; state: string }[]; notes: { text: string }[] }[];
  schedules: { id: string; name: string; paused: boolean; nextRunAt?: number; runs: { outcome: string }[] }[];
}

async function getBot(id: string): Promise<{ bot: BotView; soul: string; memory: { text: string; kind?: string }[] }> {
  const res = await fetch(`${base}/bots/${id}`);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as { bot: BotView; soul: string; memory: { text: string; kind?: string }[] };
}

async function createBot(body: Record<string, unknown> = {}): Promise<{ id: string; roomId: string }> {
  const res = await fetch(`${base}/bots`, {
    method: "POST",
    body: JSON.stringify({ name: "Vigia", soul: "I watch the CI.\n\n## Never\n- Merge anything.", agentId: "claude", model: "haiku", cwd: host.dir, ...body }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { bot: { id: string; roomId: string } }).bot;
}

/** One turn of the bot: what its tool calls answered. */
async function botTurn(socket: WebSocket, text: string): Promise<{ last: string; results: { content: string; isError: boolean }[] }> {
  const done = collectUntil(socket, isTurnEnded, 30_000);
  sendUserMessage(socket, text);
  const events = (await done).filter((message) => message.type === "agent_event").map((message) => message.event as Record<string, unknown>);
  const results = events.filter((event) => event.type === "tool_ended").map((event) => ({ content: String(event.content), isError: event.isError === true }));
  const texts = events.filter((event) => event.type === "text").map((event) => (typeof event.text === "string" ? event.text : ""));
  return { last: ([...texts].reverse().find((text) => text.startsWith("room: ")) ?? "").slice("room: ".length), results };
}

test("a bot is created with its files and a kickoff turn, and is listed with the bots, not the conversations", async () => {
  const watch = await connectSessionListWatch(relay.port);
  const seen: Record<string, unknown>[] = [];
  watch.on("message", (raw: Buffer) => seen.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  try {
    const { id, roomId } = await createBot({ schedules: [{ name: "Morning check", cron: "0 9 * * 1-5", prompt: "Check the CI." }] });
    const { bot, soul } = await getBot(id);
    assert.equal(bot.roomId, roomId);
    assert.equal(bot.firstRun, true);
    assert.match(soul, /I watch the CI/);
    assert.deepEqual(
      bot.schedules.map((schedule) => ({ name: schedule.name, paused: schedule.paused, armed: schedule.nextRunAt !== undefined })),
      [{ name: "Morning check", paused: true, armed: false }],
      "a template's schedule waits, paused, for the person",
    );

    // The kickoff reached the bot as a relay note, not a bubble.
    const socket = await connectSession(relay.port, roomId);
    try {
      await waitFor(async () => {
        const history = ((await (await fetch(`${base}/rooms/${roomId}`)).json()) as { members: { id: string }[] }).members;
        return history.length >= 1;
      });
    } finally {
      socket.close();
    }

    const sessions = ((await (await fetch(`${base}/sessions`)).json()) as { sessions: { id: string }[] }).sessions.map((row) => row.id);
    assert.ok(!sessions.includes(roomId), "the bot's conversation is not a conversation of the list");
    const listed = ((await (await fetch(`${base}/bots`)).json()) as { bots: { id: string; name: string }[] }).bots;
    assert.ok(listed.some((each) => each.id === id && each.name === "Vigia"));
    await waitFor(() => seen.some((message) => message.type === "bots_state" && (message.bots as { id: string }[]).some((each) => each.id === id)), 5000, "a bots_state with the new bot");
    assert.ok(seen.some((message) => message.type === "bots_state"), "the watcher got the bots");
  } finally {
    watch.close();
  }
});

test("a bot wears the character and tone picked for it, and only known ones", async () => {
  const bad = await fetch(`${base}/bots`, { method: "POST", body: JSON.stringify({ name: "Rosto", soul: "I watch.", agentId: "claude", model: "haiku", cwd: host.dir, mascot: { character: "dragon", tone: "sand" } }) });
  assert.equal(bad.status, 400);
  const { id } = await createBot({ name: "Rosto", mascot: { character: "screen", tone: "stone" } });
  assert.deepEqual((await getBot(id)).bot.mascot, { character: "screen", tone: "stone" });
  const patched = await fetch(`${base}/bots/${id}`, { method: "PATCH", body: JSON.stringify({ mascot: { character: "chip", tone: "rose" } }) });
  assert.equal(patched.status, 200, await patched.clone().text());
  assert.deepEqual((await getBot(id)).bot.mascot, { character: "chip", tone: "rose" });
  const refused = await fetch(`${base}/bots/${id}`, { method: "PATCH", body: JSON.stringify({ mascot: { seed: "Rosto" } }) });
  assert.equal(refused.status, 400);
  assert.equal((await fetch(`${base}/bots/${id}`, { method: "DELETE" })).status, 200);
});

test("a scheduled run that hits the agent's usage limit is recorded as limited, and the bot waits before running again", async () => {
  const { id } = await createBot({ name: "Limitado", schedules: [{ name: "Check", cron: "0 9 * * 1-5", prompt: "[[usage-limit]]" }] });
  try {
    const before = Date.now();
    const scheduleId = (await getBot(id)).bot.schedules[0].id;
    assert.equal((await fetch(`${base}/bots/${id}/schedules/${scheduleId}/run`, { method: "POST" })).status, 200);
    await waitFor(async () => (await getBot(id)).bot.schedules[0].runs[0]?.outcome === "limited", 20_000, "a limited run");
    const { bot } = await getBot(id);
    assert.equal(bot.lastRunFailed, false, "a usage limit is not the bot failing");
    const limitedUntil = bot.limitedUntil;
    assert.ok(limitedUntil !== undefined && limitedUntil >= before + 59 * 60_000, "it waits (an hour, with no plan usage to read)");
  } finally {
    await fetch(`${base}/bots/${id}`, { method: "DELETE" });
  }
});

test("the bot keeps a task list: create, ask, the person answers, delegate a worker to it, and its worker is archived once the task is done", async () => {
  const { id, roomId } = await createBot({ name: "Tarefas" });
  const socket = await connectSession(relay.port, roomId);
  try {
    // The kickoff turn may still be running: wait for the bot to be idle.
    await waitFor(async () => !((await (await fetch(`${base}/bots`)).json()) as { bots: { id: string; busy: boolean }[] }).bots.find((each) => each.id === id)?.busy, 20_000, "the kickoff to end");

    const created = await botTurn(socket, `plan ${marker("task_create", { title: "Fix the flaky test", done_means: "20 green runs" })}`);
    assert.deepEqual(JSON.parse(created.last), { task: 1 });

    const asked = await botTurn(socket, `ask ${marker("task_ask", { task: 1, question: "Retry per test or per job?", options: ["Per test", "Per job"], recommended: 0 })}`);
    assert.equal(asked.results[0].isError, false, asked.results[0].content);
    let view = (await getBot(id)).bot;
    assert.equal(view.tasks[0].status, "needs_you", "a question on a task is the task needing the person");
    assert.equal(view.needsYou, 1);

    const answered = await fetch(`${base}/bots/${id}/tasks/1/answer`, { method: "POST", body: JSON.stringify({ answer: "Per test" }) });
    assert.equal(answered.status, 200, await answered.text());
    view = (await getBot(id)).bot;
    assert.equal(view.tasks[0].question, undefined);
    assert.equal(view.tasks[0].status, "planned");
    assert.ok(view.tasks[0].notes.some((note) => note.text === "Answered: Per test"));
    // The answer is the bot's next turn.
    await waitFor(async () => {
      const res = await fetch(`${base}/bots`);
      return !((await res.json()) as { bots: { id: string; busy: boolean }[] }).bots.find((each) => each.id === id)?.busy;
    }, 20_000, "the answer turn to end");

    const report = marker("report", { status: "done", summary: "fixed on branch x" });
    const delegated = await botTurn(socket, `go ${marker("delegate", { name: "Fixer", purpose: "fixes tests", task: `Fix it ${report}`, runtime: "claude", model: "haiku", task_number: 1 })}`);
    assert.equal(delegated.results[0].isError, false, delegated.results[0].content);
    const { agentId } = JSON.parse(delegated.last) as { agentId: string };
    view = (await getBot(id)).bot;
    assert.equal(view.tasks[0].status, "working");
    assert.deepEqual(view.tasks[0].workers.map((worker) => worker.agentId), [agentId]);

    // A task that does not exist takes no worker.
    const refused = await botTurn(socket, `go ${marker("delegate", { name: "Other", purpose: "x", task: "x", runtime: "claude", model: "haiku", task_number: 99 })}`);
    assert.equal(refused.results[0].isError, true);
    assert.match(refused.results[0].content, /no task #99/);

    // The worker reports; its report reaches the bot as a digest.
    await waitFor(async () => (await getBot(id)).bot.tasks[0].workers[0]?.state === "done", 20_000, "the worker's report");
    const snapshotHas = async (): Promise<boolean> => {
      const members = ((await (await fetch(`${base}/rooms/${roomId}`)).json()) as { members: { id: string }[] }).members.map((member) => member.id);
      return members.includes(agentId);
    };
    assert.equal(await snapshotHas(), true, "its session stays");

    // Done: the worker leaves what the bot sees live, once its report was
    // handed to the bot.
    await waitFor(async () => {
      const members = ((await (await fetch(`${base}/rooms/${roomId}`)).json()) as { members: { id: string; room: { undeliveredReports?: string[] } }[] }).members;
      const outbox = members.find((member) => member.id === roomId)?.room.undeliveredReports ?? [];
      const busy = ((await (await fetch(`${base}/bots`)).json()) as { bots: { id: string; busy: boolean }[] }).bots.find((each) => each.id === id)?.busy;
      return outbox.length === 0 && !busy;
    }, 20_000, "the digest to reach the bot");
    const closed = await botTurn(socket, `close ${marker("task_update", { task: 1, status: "done", note: "merged" })} ${marker("bot_status", {})}`);
    const status = JSON.parse(closed.last) as { agents: { agentId: string }[]; tasks: unknown[]; schedules: unknown[] };
    assert.deepEqual(status.agents, [], "an archived worker is not listed");
    assert.deepEqual(status.tasks, []);
    // Its name is free again.
    const again = await botTurn(socket, `new ${marker("task_create", { title: "Next" })} ${marker("delegate", { name: "Fixer", purpose: "fixes tests", task: "next one", runtime: "claude", model: "haiku", task_number: 2 })}`);
    assert.equal(again.results[1].isError, false, again.results[1].content);
  } finally {
    socket.close();
  }
});

test("memory, soul and schedules through the bot's tools; a scheduled run with nothing to say stays silent", async () => {
  const { id, roomId } = await createBot({ name: "Memória" });
  const socket = await connectSession(relay.port, roomId);
  try {
    await waitFor(async () => !((await (await fetch(`${base}/bots`)).json()) as { bots: { id: string; busy: boolean }[] }).bots.find((each) => each.id === id)?.busy, 20_000, "the kickoff to end");

    const tools = await botTurn(
      socket,
      `learn ${marker("remember", { kind: "rule", text: "Never merge" })} ${marker("remember", { kind: "fact", text: "CI runs on main" })} ${marker("forget", { text: "CI runs on main" })} ${marker("set_soul", { text: "I watch.\n\n## How I work\n- quietly" })} ${marker("schedule_create", { name: "Hourly", cron: "0 * * * *", prompt: "[[look-then-silent]]" })} ${marker("schedule_create", { name: "Bad", cron: "every hour", prompt: "x" })}`,
    );
    assert.deepEqual(tools.results.map((result) => result.isError), [false, false, false, false, false, true], tools.results.map((result) => result.content).join("\n"));
    const { bot, soul, memory } = await getBot(id);
    assert.equal(bot.firstRun, false, "writing its soul ends the first run");
    assert.match(soul, /## How I work/);
    assert.deepEqual(memory.map((line) => ({ text: line.text, kind: line.kind })), [{ text: "Never merge", kind: "rule" }]);
    assert.equal(bot.schedules.length, 1);
    assert.ok(bot.schedules[0].nextRunAt !== undefined && bot.schedules[0].nextRunAt > Date.now(), "a schedule the bot creates is armed");

    // "Run now": the run looks something up and answers NO_REPLY — nothing
    // of it reaches the conversation.
    const scheduleId = bot.schedules[0].id;
    const shown: Record<string, unknown>[] = [];
    const listen = (raw: Buffer): void => {
      shown.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    };
    socket.on("message", listen);
    const ran = await fetch(`${base}/bots/${id}/schedules/${scheduleId}/run`, { method: "POST" });
    assert.equal(ran.status, 200, await ran.text());
    await waitFor(async () => (await getBot(id)).bot.schedules[0].runs.length === 1, 20_000, "the run to be recorded");
    assert.equal((await getBot(id)).bot.schedules[0].runs[0].outcome, "silent");
    socket.off("message", listen);
    assert.ok(!shown.some((message) => message.type === "agent_event" && (message.event as { type: string }).type === "tool_started"), "the silent run's lookup is not shown");
    assert.ok(
      shown.some((message) => message.type === "agent_event" && (message.event as { type: string; synthetic?: string }).type === "user_message" && (message.event as { synthetic?: string }).synthetic === "bot_schedule"),
      "its note is: the person sees each automation that ran",
    );
    assert.ok(!shown.some((message) => message.type === "agent_event" && (message.event as { type: string; text?: string }).type === "text"), "and none of its words");

    // The person edits the memory and pauses the schedule.
    const edited = await fetch(`${base}/bots/${id}/memory/0`, { method: "PATCH", body: JSON.stringify({ text: "Never merge to main" }) });
    assert.equal(edited.status, 200);
    assert.equal((await getBot(id)).memory[0].text, "Never merge to main");
    const paused = await fetch(`${base}/bots/${id}/schedules/${scheduleId}`, { method: "PATCH", body: JSON.stringify({ paused: true }) });
    assert.equal(paused.status, 200);
    assert.equal((await getBot(id)).bot.schedules[0].nextRunAt, undefined, "a paused schedule is not armed");
  } finally {
    socket.close();
  }
});

test("a scheduled run's result reaches the phone, titled with its schedule; the bot's replies and a run with nothing to say do not", async () => {
  // A local HTTP server plays the push gateway, as in push.test.ts.
  const pushed: { kind: string; title: string | null; preview: string | null }[] = [];
  const gateway = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      pushed.push((JSON.parse(raw) as { event: { kind: string; title: string | null; preview: string | null } }).event);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ rejected: [], failed: [] }));
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const device = "7c1e2f3a-4b5c-4d6e-8f9a-0b1c2d3e4f5a";
  const registered = await fetch(`${base}/push/devices/${device}`, {
    method: "PUT",
    body: JSON.stringify({ gatewayUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/push/v1/notify`, pushKey: "bot-key" }),
  });
  assert.equal(registered.status, 204);
  const { id, roomId } = await createBot({ name: "Bob" });
  const socket = await connectSession(relay.port, roomId);
  try {
    await waitFor(async () => !((await (await fetch(`${base}/bots`)).json()) as { bots: { id: string; busy: boolean }[] }).bots.find((each) => each.id === id)?.busy, 20_000, "the kickoff to end");
    await botTurn(socket, `plan ${marker("schedule_create", { name: "Morning", cron: "0 9 * * *", prompt: "Say good morning." })} ${marker("schedule_create", { name: "Quiet", cron: "0 * * * *", prompt: "[[look-then-silent]]" })}`);
    const [morning, quiet] = (await getBot(id)).bot.schedules;

    const silent = await fetch(`${base}/bots/${id}/schedules/${quiet.id}/run`, { method: "POST" });
    assert.equal(silent.status, 200, await silent.text());
    await waitFor(async () => (await getBot(id)).bot.schedules[1].runs.length === 1, 20_000, "the quiet run to be recorded");

    const ran = await fetch(`${base}/bots/${id}/schedules/${morning.id}/run`, { method: "POST" });
    assert.equal(ran.status, 200, await ran.text());
    await waitFor(() => pushed.length > 0, 20_000, "the run's push");
    // Late pushes of the turns above would show up by now too.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(
      pushed.map((event) => ({ kind: event.kind, title: event.title })),
      [{ kind: "turn_completed", title: "Bob · Morning" }],
      "only the scheduled run that said something: not the kickoff, the reply, or the quiet run",
    );
    assert.match(pushed[0].preview ?? "", /Say good morning\./);
  } finally {
    socket.close();
    await fetch(`${base}/push/devices/${device}`, { method: "DELETE" });
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});

test("deleting a bot deletes its room and its files", async () => {
  const { id, roomId } = await createBot({ name: "Efêmero" });
  await waitFor(async () => !((await (await fetch(`${base}/bots`)).json()) as { bots: { id: string; busy: boolean }[] }).bots.find((each) => each.id === id)?.busy, 20_000, "the kickoff to end");
  // A soul the person writes ends the bot's first run.
  assert.equal((await getBot(id)).bot.firstRun, true);
  const patched = await fetch(`${base}/bots/${id}`, { method: "PATCH", body: JSON.stringify({ soul: "I tidy up." }) });
  assert.equal(patched.status, 200);
  assert.equal((await getBot(id)).bot.firstRun, false);
  const res = await fetch(`${base}/bots/${id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal((await fetch(`${base}/bots/${id}`)).status, 404);
  assert.equal((await fetch(`${base}/rooms/${roomId}`)).status, 404);
});

const askMarker = (call: unknown): string => `[[ask:${Buffer.from(JSON.stringify(call)).toString("base64url")}]]`;

test("a bot just created puts a tool call needing approval to the person, and is never listed as a conversation", async () => {
  const watch = await connectSessionListWatch(relay.port);
  const listed: string[] = [];
  watch.on("message", (raw: Buffer) => {
    const message = JSON.parse(raw.toString()) as { type: string; id?: string; sessions?: { id: string }[] };
    if (message.type === "session_list_upsert" && message.id) listed.push(message.id);
    for (const session of message.sessions ?? []) listed.push(session.id);
  });
  try {
    // Asks before writing: its tool calls need the person.
    const { id, roomId } = await createBot({ name: "Cauteloso", permissionMode: "default" });
    await waitFor(async () => !((await (await fetch(`${base}/bots`)).json()) as { bots: { id: string; busy: boolean }[] }).bots.find((each) => each.id === id)?.busy, 20_000, "the kickoff to end");
    const socket = await connectSession(relay.port, roomId);
    try {
      // Without deferred approval the turn would hang open on a person.
      const done = collectUntil(socket, isTurnEnded, 20_000);
      sendUserMessage(socket, `write it ${askMarker({ tool: "Write", input: { file_path: join(host.dir, "x.txt"), content: "x" } })}`);
      await done;
    } finally {
      socket.close();
    }
    await waitFor(async () => ((await getBot(id)).bot as BotView & { conversationNeedsYou: boolean }).conversationNeedsYou, 10_000, "the approval card");
    assert.ok(!listed.includes(roomId), "the bot's conversation was never announced as a conversation");
  } finally {
    watch.close();
  }
});

test("canceling a task stops its agent and tells the bot", async () => {
  const { id, roomId } = await createBot({ name: "Cancela" });
  await waitFor(async () => !((await (await fetch(`${base}/bots`)).json()) as { bots: { id: string; busy: boolean }[] }).bots.find((each) => each.id === id)?.busy, 20_000, "the kickoff to end");
  const gate = join(host.dir, `never-${id}`);
  const socket = await connectSession(relay.port, roomId);
  try {
    const delegated = await botTurn(socket, `go ${marker("task_create", { title: "Long job" })} ${marker("delegate", { name: "Slow", purpose: "slow", task: `work [[gate:${gate}]]`, runtime: "claude", model: "haiku", task_number: 1 })}`);
    const { agentId } = JSON.parse(delegated.last) as { agentId: string };
    await waitFor(async () => (await getBot(id)).bot.tasks[0].workers[0]?.state === "working", 20_000, "the agent at work");
    const notes: Record<string, unknown>[] = [];
    socket.on("message", (raw: Buffer) => notes.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    const res = await fetch(`${base}/bots/${id}/tasks/1/cancel`, { method: "POST" });
    assert.equal(res.status, 200);
    await waitFor(async () => (await getBot(id)).bot.tasks[0].workers.find((worker) => worker.agentId === agentId)?.state === "stopped", 20_000, "the agent stopped");
    assert.equal((await getBot(id)).bot.tasks[0].status, "canceled");
    await waitFor(() => notes.some((m) => m.type === "agent_event" && (m.event as { synthetic?: string; label?: string }).synthetic === "bot_note" && (m.event as { label?: string }).label === "cancel:1"), 20_000, "the bot told");
  } finally {
    socket.close();
  }
});
