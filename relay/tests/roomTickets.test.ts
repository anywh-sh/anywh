// Tickets in a room, across real processes: the agent host running the fake
// `claude` in its persistent mode, the real relay with a profile that has
// Jira (helpers/fakeJira.ts). A ticket handed to the principal is only
// carried (a line in its prompt, kept until delegated), the agent it
// delegates with that ticket works on it (its link, the line in its first
// prompt, its card and the room's tickets), an agent without one is linked by
// the first ticket it opens, the principal never is, and none of the lines
// shows in a history rebuilt after a relay restart. Only the CLIs are faked.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import type { RoomAgentView, RoomSummary } from "../src/session/roomState.js";
import type { RoomTicketView, TicketRef, WorkTicket } from "../src/integrations/types.js";
import { startHostProcess, type HostProcess } from "./helpers/agentHostProcess.js";
import { FAKE_JIRA_SITE, fakeJiraEnv, jiraOf, mcpCallMarker, openRecorded } from "./helpers/fakeJira.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { isTurnEnded } from "./helpers/wsClient.js";

const SERVER = "claude_ai_Atlassian";
const work = mkdtempSync(join(tmpdir(), "anywh-room-tickets-it-"));
const promptsFile = join(work, "prompts.jsonl");
let env: Record<string, string>;
let host: HostProcess;
let relay: SpawnedServer | undefined;
let watch: Awaited<ReturnType<typeof openRecorded>>;
const sockets: WebSocket[] = [];
let base = "";

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${relay?.output.join("").slice(-3000) ?? ""}\n${host?.output.join("").slice(-3000) ?? ""}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function startRelay(port?: number): Promise<void> {
  relay = await spawnRelay({ ...env, ...(port ? { RELAY_PORT: String(port) } : {}) });
  base = `http://127.0.0.1:${relay.port}`;
  await waitFor(async () => (await fetch(`${base}/agents/activity`).catch(() => undefined))?.status === 200, "relay connected to the host");
  watch = await openRecorded(relay.port, "/integrations/watch");
  sockets.push(watch.socket);
}

async function stopRelay(): Promise<number> {
  for (const socket of sockets.splice(0)) socket.close();
  const current = relay!;
  relay = undefined;
  current.proc.kill("SIGTERM");
  await current.waitForExit();
  current.cleanup();
  return current.port;
}

before(async () => {
  env = fakeJiraEnv(work);
  // The agents' home is the relay's: a relay restarted on it reads their
  // transcripts.
  host = startHostProcess(work, env.HOME, { FAKE_CLAUDE_PROMPTS_FILE: promptsFile, FAKE_CLAUDE_TRANSCRIPT: "1" });
  // A warm-up window (spawnRelay has none) lets a worker be linked by hand
  // while it waits behind a sibling; a leader whose turn ends closes it.
  env = { ...env, ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_WORKTREES_ROOT: join(work, "worktrees"), RELAY_ROOM_WARMUP_MS: "3000" };
  await startRelay();
  // Jira through claude.ai; one read of my tickets tells the relay its site.
  await watch.recorded.waitFor((message) => jiraOf(message)?.runtimes.some((runtime) => runtime.runtimeId === "claude" && runtime.status === "connected") === true, 0, 30_000);
  watch.socket.send(JSON.stringify({ type: "integration_refresh", id: "jira", query: "mine", param: null, force: false }));
  await watch.recorded.waitFor((message) => jiraOf(message)?.site?.id === FAKE_JIRA_SITE.id);
});

after(async () => {
  if (relay) await stopRelay();
  await host?.stop();
  rmSync(work, { recursive: true, force: true });
});

const roomMarker = (tool: string, args: unknown): string => `[[room:${tool}:${Buffer.from(JSON.stringify(args)).toString("base64url")}]]`;
const reported = roomMarker("report", { status: "done", summary: "done", artifacts: [] });
const ticket = (key: string): TicketRef => ({ provider: "jira", site: FAKE_JIRA_SITE.id, key });

/** Every prompt an agent received so far. */
const prompts = (): string[] => (existsSync(promptsFile) ? readFileSync(promptsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string) : []);
const promptWith = (text: string): string | undefined => prompts().find((prompt) => prompt.includes(text));

interface Member {
  id: string;
  title: string | null;
  room: { role: string; ticket?: TicketRef; carriedTickets?: string[] };
}
const members = async (roomId: string): Promise<Member[]> => ((await (await fetch(`${base}/rooms/${roomId}`)).json()) as { members: Member[] }).members;

async function createRoom(body: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", cwd: work, title: "Release room", ...body }) });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { roomId: string }).roomId;
}

async function chat(id: string) {
  const opened = await openRecorded(relay!.port, `/?session=${id}`);
  sockets.push(opened.socket);
  await opened.recorded.waitFor((message) => message.type === "caught_up");
  return opened;
}

/** One turn of a session; the tool results of the turn. */
async function turn(session: Awaited<ReturnType<typeof chat>>, text: string, startTicket?: TicketRef): Promise<{ content: string; isError: boolean }[]> {
  const since = session.recorded.mark();
  session.socket.send(JSON.stringify({ type: "user_message", text, ...(startTicket ? { startTicket } : {}) }));
  await session.recorded.waitFor(isTurnEnded, since, 30_000);
  return session.recorded.messages
    .slice(since)
    .map((message) => message.event as { type?: string; content?: unknown; isError?: boolean } | undefined)
    .filter((event) => event?.type === "tool_ended")
    .map((event) => ({ content: String(event!.content), isError: event!.isError === true }));
}

/** The links as a new watcher of the profile sees them. */
async function linksNow(): Promise<WorkTicket[]> {
  const fresh = await openRecorded(relay!.port, "/integrations/watch");
  const state = await fresh.recorded.waitFor((message) => message.type === "work_tickets_state");
  fresh.socket.close();
  return state.links as WorkTicket[];
}

/** The room as its watcher sees it now: every agent and the summary. */
function roomState(recorded: Awaited<ReturnType<typeof openRecorded>>["recorded"]): { agents: Map<string, RoomAgentView>; summary?: RoomSummary } {
  const agents = new Map<string, RoomAgentView>();
  let summary: RoomSummary | undefined;
  for (const message of recorded.messages) {
    if (message.type === "room_snapshot") {
      agents.clear();
      for (const agent of message.agents as RoomAgentView[]) agents.set(agent.agentId, agent);
      summary = message.summary as RoomSummary;
    } else if (message.type === "room_agent_state") {
      const agent = message.agent as RoomAgentView;
      agents.set(agent.agentId, agent);
    } else if (message.type === "room_summary") {
      summary = message.summary as RoomSummary;
    }
  }
  return { agents, summary };
}

const ticketsOf = (summary: RoomSummary | undefined): RoomTicketView[] | undefined => summary?.tickets;
const upsertOf = (sessionId: string, also: (link: WorkTicket) => boolean = () => true) => (message: Record<string, unknown>) =>
  message.type === "work_ticket_upsert" && (message.link as WorkTicket).sessionId === sessionId && also(message.link as WorkTicket);

let roomId = "";
let fixerId = "";

test("the principal carries a ticket it is handed and the agent it delegates with it works on it", async () => {
  roomId = await createRoom();
  const room = await openRecorded(relay!.port, `/rooms/${roomId}/watch`);
  sockets.push(room.socket);
  const principal = await chat(roomId);

  // Handed with a message (any message of the principal): only carried.
  await turn(principal, "plan the release", ticket("NGL-9"));
  assert.ok(promptWith("plan the release")?.startsWith("Jira ticket to delegate: NGL-9\n\nplan the release"), promptWith("plan the release"));
  assert.deepEqual((await members(roomId)).find((member) => member.id === roomId)?.room.carriedTickets, ["NGL-9"]);
  assert.ok(!(await linksNow()).some((link) => link.sessionId === roomId), "the principal works on no ticket");
  await waitFor(() => JSON.stringify(ticketsOf(roomState(room.recorded).summary)) === JSON.stringify([{ provider: "jira", key: "NGL-9", agentIds: [], carried: true }]), "the room's tickets: NGL-9 with the principal");
  // Nor can the person give it one.
  const refusedSince = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "work_ticket", sessionId: roomId, action: "link", ticket: ticket("NGL-1") }));
  assert.deepEqual(await watch.recorded.waitFor((message) => message.type === "work_ticket_result" && message.sessionId === roomId, refusedSince), { type: "work_ticket_result", sessionId: roomId, error: "conflict" });

  // It delegates the work with the ticket.
  const since = watch.recorded.mark();
  const [delegated] = await turn(principal, roomMarker("delegate", { name: "Fixer", purpose: "fixes bugs", task: `Fix the login ${reported}`, runtime: "claude", model: "haiku", ticket: "NGL-9" }));
  assert.equal(delegated?.isError, false, delegated?.content);
  const result = JSON.parse(delegated.content) as { agentId: string; ticket?: string; warning?: string };
  fixerId = result.agentId;
  assert.deepEqual({ ticket: result.ticket, warning: result.warning }, { ticket: "NGL-9", warning: undefined });
  assert.ok(!promptWith("[[room:delegate")?.startsWith("Jira ticket"), "a message without a ticket carries no line");

  const linked = (await watch.recorded.waitFor(upsertOf(fixerId), since)).link as WorkTicket;
  assert.deepEqual({ ticket: linked.ticket, origin: linked.origin, lineDue: linked.lineDue }, { ticket: ticket("NGL-9"), origin: "delegate", lineDue: false });
  // Its place follows the agent: re-announced as its state changes.
  const done = (await watch.recorded.waitFor(upsertOf(fixerId, (link) => link.place?.agentState === "done"), since)).link as WorkTicket;
  assert.deepEqual(done.place, { roomId, roomTitle: "Release room", agentTitle: "Fixer", agentState: "done" });

  // Its first prompt tells it, before the instruction card.
  const first = promptWith("Fix the login")!;
  assert.ok(first.startsWith("Jira ticket: NGL-9\n\nFix the login"), first);
  assert.ok(first.indexOf("[anywh-card]") > first.indexOf("Fix the login"), first);

  // Its card and the room's tickets show it; the principal no longer holds it.
  await waitFor(() => {
    const state = roomState(room.recorded);
    return state.agents.get(fixerId)?.ticket?.key === "NGL-9" && JSON.stringify(ticketsOf(state.summary)) === JSON.stringify([{ provider: "jira", key: "NGL-9", agentIds: [fixerId] }]);
  }, "the worker's card and the room's tickets");
  const state = roomState(room.recorded);
  assert.deepEqual(state.agents.get(fixerId)?.ticket, { provider: "jira", key: "NGL-9" });
  assert.equal(state.agents.get(roomId)?.ticket, undefined);
  const listed = await members(roomId);
  assert.equal(listed.find((member) => member.id === roomId)?.room.carriedTickets, undefined);
  assert.deepEqual(listed.find((member) => member.id === fixerId)?.room.ticket, ticket("NGL-9"));

  // A ticket that is not a key is dropped, never the delegation.
  const [loose] = await turn(principal, roomMarker("delegate", { name: "Helper", purpose: "helps", task: `Look around ${reported}`, runtime: "claude", model: "haiku", ticket: "the login bug" }));
  assert.equal(loose?.isError, false, loose?.content);
  const helper = JSON.parse(loose.content) as { agentId: string; ticket?: string; warning?: string };
  assert.match(helper.warning ?? "", /not a ticket key/);
  assert.equal(helper.ticket, undefined);
  await waitFor(() => promptWith("Look around") !== undefined, "the helper's first prompt");
  assert.ok(!promptWith("Look around")!.startsWith("Jira ticket"), promptWith("Look around"));

  // The person starts an agent from the canvas with a ticket: the same.
  const res = await fetch(`${base}/rooms/${roomId}/agents`, { method: "POST", body: JSON.stringify({ name: "Writer", task: `Write the notes ${reported}`, ticket: "NGL-2" }) });
  assert.equal(res.status, 201, await res.clone().text());
  const { agentId: writerId } = (await res.json()) as { agentId: string };
  await waitFor(() => promptWith("Write the notes") !== undefined, "the writer's first prompt");
  assert.ok(promptWith("Write the notes")!.startsWith("Jira ticket: NGL-2\n\nWrite the notes"), promptWith("Write the notes"));
  const links = await linksNow();
  assert.deepEqual(links.find((link) => link.sessionId === writerId)?.origin, "delegate");
  assert.ok(!links.some((link) => link.sessionId === helper.agentId));
});

test("a room opened with a ticket hands it to its principal", async () => {
  const opened = await createRoom({ firstMessage: "ship NGL-4", ticket: "NGL-4" });
  await waitFor(() => promptWith("ship NGL-4") !== undefined, "the principal's first prompt");
  assert.ok(promptWith("ship NGL-4")!.startsWith("Jira ticket to delegate: NGL-4\n\nship NGL-4"), promptWith("ship NGL-4"));
  assert.deepEqual((await members(opened)).find((member) => member.id === opened)?.room.carriedTickets, ["NGL-4"]);
  const bad = await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", cwd: work, firstMessage: "x", ticket: "nope" }) });
  assert.equal(bad.status, 400);
});

test("an agent without a ticket works on the first one it opens; the principal opening one works on none", async () => {
  const principal = await chat(roomId);
  const since = watch.recorded.mark();
  const [delegated] = await turn(
    principal,
    roomMarker("delegate", { name: "Reader", purpose: "reads tickets", task: `Read it ${mcpCallMarker(SERVER, "getJiraIssue", { cloudId: FAKE_JIRA_SITE.id, issueIdOrKey: "NGL-3" })} ${reported}`, runtime: "claude", model: "haiku" }),
  );
  const { agentId: readerId } = JSON.parse(delegated.content) as { agentId: string };
  const linked = (await watch.recorded.waitFor(upsertOf(readerId), since, 20_000)).link as WorkTicket;
  assert.deepEqual({ key: linked.ticket.key, origin: linked.origin, evidence: linked.evidence }, { key: "NGL-3", origin: "mcp", evidence: "getJiraIssue" });

  const principalSince = watch.recorded.mark();
  const [opened] = await turn(principal, `what is NGL-1 ${mcpCallMarker(SERVER, "getJiraIssue", { cloudId: FAKE_JIRA_SITE.id, issueIdOrKey: "NGL-1" })}`);
  assert.equal(opened?.isError, false, "the principal's call went through untouched");
  // Seen (the cache took it), not linked.
  await watch.recorded.waitFor((message) => jiraOf(message)?.queries.some((query) => query.query === "ticket" && query.param === "NGL-1" && query.source === "turn") === true, principalSince);
  assert.ok(!(await linksNow()).some((link) => link.sessionId === roomId));
});

test("a worker linked by hand before its first task starts is told once, by that task", async () => {
  const room = await createRoom({ title: "Hand room" });
  const principal = await chat(room);
  // Two agents of the same model at once: the second waits behind the
  // first one's cache warm-up (the first is held in its turn meanwhile),
  // time enough to link it by hand.
  const gate = join(work, "hand-room-gate");
  const [, second] = await turn(
    principal,
    roomMarker("delegate", { name: "First", purpose: "goes first", task: `Lead the way [[gate:${gate}]] ${reported}`, runtime: "claude", model: "haiku" }) +
      roomMarker("delegate", { name: "Second", purpose: "waits", task: `Follow along ${reported}`, runtime: "claude", model: "haiku" }),
  );
  assert.equal(second?.isError, false, second?.content);
  const { agentId: secondId } = JSON.parse(second.content) as { agentId: string };
  assert.equal(promptWith("Follow along"), undefined, "the second agent is still waiting");
  const since = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "work_ticket", sessionId: secondId, action: "link", ticket: ticket("NGL-5") }));
  assert.deepEqual(await watch.recorded.waitFor((message) => message.type === "work_ticket_result" && message.sessionId === secondId, since), { type: "work_ticket_result", sessionId: secondId, ok: true });

  writeFileSync(gate, "");
  await waitFor(() => promptWith("Follow along") !== undefined, "the second agent's first prompt", 30_000);
  assert.ok(promptWith("Follow along")!.startsWith("Jira ticket: NGL-5\n\nFollow along"), promptWith("Follow along"));
  await waitFor(async () => (await linksNow()).find((link) => link.sessionId === secondId)?.lineDue === false, "the line paid by its task");
  // The person's next message does not tell it again.
  const worker = await chat(secondId);
  await turn(worker, "anything else?");
  await waitFor(() => promptWith("anything else?") !== undefined, "the person's message");
  assert.ok(!promptWith("anything else?")!.includes("Jira ticket"), promptWith("anything else?"));
});

test("after a relay restart the principal's and the worker's histories show no ticket line", async () => {
  // The lines are in what the agents' own transcripts hold...
  const projects = join(env.HOME, ".claude", "projects");
  const transcripts = readdirSync(projects, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(projects, name), "utf8"))
    .join("\n");
  assert.ok(transcripts.includes("Jira ticket to delegate: NGL-9"));
  assert.ok(transcripts.includes("Jira ticket: NGL-9"));

  // ...and not in the history a new relay rebuilds from them.
  await startRelay(await stopRelay());
  const bubbles = async (id: string): Promise<string[]> => {
    const opened = await chat(id);
    const page = opened.recorded.messages.find((message) => message.type === "history_page") as { messages: { event: { type: string; text?: string } }[] } | undefined;
    return (page?.messages ?? []).filter((message) => message.event.type === "user_message").map((message) => message.event.text ?? "");
  };
  const principal = await bubbles(roomId);
  assert.ok(principal.includes("plan the release"), JSON.stringify(principal));
  assert.ok(!principal.some((text) => text.includes("Jira ticket")), JSON.stringify(principal));
  assert.deepEqual((await bubbles(fixerId))[0], `Fix the login ${reported}`);
});
