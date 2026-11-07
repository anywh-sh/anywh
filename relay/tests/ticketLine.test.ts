// The hidden ticket line against the real relay: a session started from a
// ticket and one given a ticket mid-conversation tell their agent in the
// prompt of the person's next turn only (never a wakeup), while every
// device — live and after a relay restart rebuilds the history from the
// agent's own transcript — shows only what the person typed. Claude through
// the fake `claude` (which keeps a transcript, FAKE_CLAUDE_TRANSCRIPT), Codex
// through the fake app-server (which keeps its threads,
// FAKE_CODEX_THREADS_DIR). Only the CLIs are faked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import type { TicketRef, WorkTicket } from "../src/integrations/types.js";
import { FAKE_JIRA_SITE, fakeJiraEnv, openRecorded } from "./helpers/fakeJira.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { isTurnEnded } from "./helpers/wsClient.js";

const work = mkdtempSync(join(tmpdir(), "anywh-ticket-line-it-"));
const argvFile = join(work, "claude-argv.jsonl");
const codexRequests = join(work, "codex-requests.jsonl");
let env: Record<string, string>;
let relay: SpawnedServer | undefined;
let watch: Awaited<ReturnType<typeof openRecorded>>;
const sockets: WebSocket[] = [];

const ticket = (key: string): TicketRef => ({ provider: "jira", site: FAKE_JIRA_SITE.id, key });

async function start(): Promise<SpawnedServer> {
  relay = await spawnRelay(env);
  watch = await openRecorded(relay.port, "/integrations/watch");
  sockets.push(watch.socket);
  return relay;
}

async function stop(): Promise<void> {
  for (const socket of sockets.splice(0)) socket.close();
  if (!relay) return;
  const current = relay;
  relay = undefined;
  current.proc.kill("SIGTERM");
  await current.waitForExit();
  current.cleanup();
}

before(async () => {
  env = { ...fakeJiraEnv(work), FAKE_CLAUDE_ARGV_FILE: argvFile, FAKE_CLAUDE_TRANSCRIPT: "1", FAKE_CODEX_THREADS_DIR: join(work, "codex-threads"), FAKE_CODEX_REQUESTS: codexRequests };
  mkdirSync(env.FAKE_CODEX_THREADS_DIR);
  await start();
});

after(async () => {
  await stop();
  rmSync(work, { recursive: true, force: true });
});

async function session(id: string) {
  if (!relay) throw new Error("no relay");
  const opened = await openRecorded(relay.port, `/?session=${id}`);
  sockets.push(opened.socket);
  await opened.recorded.waitFor((message) => message.type === "caught_up");
  return opened;
}

async function send(chat: Awaited<ReturnType<typeof session>>, text: string, startTicket?: TicketRef): Promise<void> {
  const since = chat.recorded.mark();
  chat.socket.send(JSON.stringify({ type: "user_message", text, ...(startTicket ? { startTicket } : {}) }));
  await chat.recorded.waitFor(isTurnEnded, since, 15_000);
}

/** The prompt of every real turn the fake `claude` was handed, in order. */
function claudePrompts(): string[] {
  return readFileSync(argvFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] === "-p" && args[args.indexOf("--output-format") + 1] === "stream-json" && !args.includes("--input-format"))
    .map((args) => args[1]);
}

/** The prompt of the turn the person typed `typed` in. */
function promptOf(typed: string): string | undefined {
  return claudePrompts().find((prompt) => prompt.endsWith(typed));
}

async function linkByHand(sessionId: string, key: string): Promise<void> {
  const since = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "work_ticket", sessionId, action: "link", ticket: ticket(key) }));
  assert.equal((await watch.recorded.waitFor((message) => message.type === "work_ticket_result" && message.sessionId === sessionId, since)).ok, true);
}

async function linksNow(): Promise<WorkTicket[]> {
  if (!relay) throw new Error("no relay");
  const fresh = await openRecorded(relay.port, "/integrations/watch");
  const state = await fresh.recorded.waitFor((message) => message.type === "work_tickets_state");
  fresh.socket.close();
  return state.links as WorkTicket[];
}

/** The bubbles a device connecting now is shown. */
async function bubbles(id: string): Promise<string[]> {
  const chat = await session(id);
  const page = chat.recorded.messages.find((message) => message.type === "history_page") as { messages: { event: { type: string; text?: string } }[] } | undefined;
  chat.socket.close();
  return (page?.messages ?? []).map((entry) => entry.event).filter((event) => event.type === "user_message").map((event) => event.text ?? "");
}

test("a session started from a ticket tells its agent in the first prompt only, and shows the typed text", async () => {
  const other = await session("s-start");
  const chat = await session("s-start");
  const since = other.recorded.mark();
  await send(chat, "fix the redirect", ticket("NGL-1144"));
  assert.equal(promptOf("fix the redirect"), "Jira ticket: NGL-1144\n\nfix the redirect");
  // Another device sees the bubble as typed.
  const shown = await other.recorded.waitFor((message) => message.type === "agent_event" && (message.event as { type: string }).type === "user_message", since);
  assert.equal((shown.event as { text: string }).text, "fix the redirect");
  const link = (await linksNow()).find((each) => each.sessionId === "s-start");
  assert.deepEqual(link && [link.origin, link.ticket.key, link.lineDue], ["start", "NGL-1144", false]);

  // A session that already had a turn is not started from anything.
  await send(chat, "and a second thing", ticket("NGL-2"));
  assert.equal(promptOf("and a second thing"), "and a second thing");
  assert.equal((await linksNow()).find((each) => each.sessionId === "s-start")?.ticket.key, "NGL-1144");
});

test("a ticket attached mid-conversation rides on the person's next message only", async () => {
  const chat = await session("s-attach");
  for (const text of ["turn one", "turn two", "turn three"]) await send(chat, text);
  await linkByHand("s-attach", "NGL-7");
  await send(chat, "turn four");
  await send(chat, "turn five");
  assert.equal(promptOf("turn four"), "Jira ticket: NGL-7\n\nturn four");
  assert.equal(promptOf("turn five"), "turn five");
  assert.equal((await linksNow()).find((each) => each.sessionId === "s-attach")?.lineDue, false);
});

test("a wakeup does not take the line; the person's next message does", async () => {
  const chat = await session("s-wake");
  await send(chat, "check back soon [[wakeup:1.5]]");
  const since = chat.recorded.mark();
  await linkByHand("s-wake", "NGL-8");
  // The wakeup's own turn, started by the relay.
  await chat.recorded.waitFor(isTurnEnded, since, 15_000);
  assert.ok(claudePrompts().includes("wakeup check"), "the wakeup's prompt went out bare");
  await send(chat, "after the wakeup");
  assert.equal(promptOf("after the wakeup"), "Jira ticket: NGL-8\n\nafter the wakeup");
});

test("unlinking before the next message drops the line", async () => {
  const chat = await session("s-unlink");
  await send(chat, "hello there");
  await linkByHand("s-unlink", "NGL-3");
  const since = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "work_ticket", sessionId: "s-unlink", action: "unlink" }));
  await watch.recorded.waitFor((message) => message.type === "work_ticket_removed" && message.sessionId === "s-unlink", since);
  await send(chat, "plain message");
  assert.equal(promptOf("plain message"), "plain message");
});

test("Codex: the first turn of a session started from a ticket carries the line", async () => {
  const chat = await session("s-codex");
  const since = chat.recorded.mark();
  chat.socket.send(JSON.stringify({ type: "set_agent", agentId: "codex" }));
  await chat.recorded.waitFor((message) => message.type === "agent_state" && message.agentId === "codex", since);
  await send(chat, "codex start", ticket("NGL-5"));
  await send(chat, "codex next");
  const inputs = readFileSync(codexRequests, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params?: { input?: { text?: string }[] } })
    .filter((request) => request.method === "turn/start")
    .map((request) => (request.params?.input ?? []).map((part) => part.text ?? "").join(""));
  assert.deepEqual(inputs, ["Jira ticket: NGL-5\n\ncodex start", "codex next"]);
});

test("after a relay restart the history rebuilt from each agent's own storage shows only the typed text", async () => {
  await stop();
  await start();
  assert.deepEqual(await bubbles("s-start"), ["fix the redirect", "and a second thing"]);
  assert.deepEqual(await bubbles("s-attach"), ["turn one", "turn two", "turn three", "turn four", "turn five"]);
  assert.deepEqual(await bubbles("s-codex"), ["codex start", "codex next"]);
});
