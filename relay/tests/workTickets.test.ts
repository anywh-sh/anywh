// Each session's work ticket against the real relay: the agent's own Jira
// calls (the fake `claude` calling the Atlassian tools of
// fixtures/fake-atlassian.mjs, scripted by a marker in the prompt) link the
// first ticket it opens and refresh the cache, `work_ticket` over
// /integrations/watch links and unlinks by hand, the session list carries
// the link, and deleting a session drops it. Only the CLIs are faked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import type { WorkTicket } from "../src/integrations/types.js";
import { FAKE_JIRA_SITE, fakeJiraEnv, jiraOf, mcpCallMarker, openRecorded } from "./helpers/fakeJira.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { isTurnEnded } from "./helpers/wsClient.js";

const SERVER = "claude_ai_Atlassian";
const work = mkdtempSync(join(tmpdir(), "anywh-work-tickets-it-"));
let relay: SpawnedServer;
let watch: Awaited<ReturnType<typeof openRecorded>>;
let list: Awaited<ReturnType<typeof openRecorded>>;
const sockets: WebSocket[] = [];

before(async () => {
  relay = await spawnRelay({ ...fakeJiraEnv(work), FAKE_ATLASSIAN_PAGE_SIZE: "2" });
  watch = await openRecorded(relay.port, "/integrations/watch");
  list = await openRecorded(relay.port, "/sessions/watch");
  sockets.push(watch.socket, list.socket);
  // The inventory is scanned once a client watches: Jira through claude.ai.
  await watch.recorded.waitFor((message) => jiraOf(message)?.runtimes.some((runtime) => runtime.runtimeId === "claude" && runtime.status === "connected") === true, 0, 30_000);
  // My open tickets, first page: NGL-2 and NGL-1.
  watch.socket.send(JSON.stringify({ type: "integration_refresh", id: "jira", query: "mine", param: null, force: false }));
  await watch.recorded.waitFor((message) => jiraOf(message)?.queries.some((query) => query.query === "mine" && !query.reading && (query.items?.length ?? 0) > 0) === true);
});

after(async () => {
  for (const socket of sockets) socket.close();
  relay.proc.kill("SIGTERM");
  await relay.waitForExit();
  relay.cleanup();
  rmSync(work, { recursive: true, force: true });
});

async function session(id: string) {
  const opened = await openRecorded(relay.port, `/?session=${id}`);
  sockets.push(opened.socket);
  await opened.recorded.waitFor((message) => message.type === "caught_up");
  return opened;
}

async function turn(chat: Awaited<ReturnType<typeof session>>, text: string): Promise<Record<string, unknown>[]> {
  const since = chat.recorded.mark();
  chat.socket.send(JSON.stringify({ type: "user_message", text }));
  await chat.recorded.waitFor(isTurnEnded, since, 15_000);
  return chat.recorded.messages.slice(since);
}

const issueCall = (key: string) => mcpCallMarker(SERVER, "getJiraIssue", { cloudId: FAKE_JIRA_SITE.id, issueIdOrKey: key });
const upsertOf = (sessionId: string) => (message: Record<string, unknown>) => message.type === "work_ticket_upsert" && (message.link as WorkTicket).sessionId === sessionId;
const resultOf = (sessionId: string) => (message: Record<string, unknown>) => message.type === "work_ticket_result" && message.sessionId === sessionId;
const toolEnds = (messages: Record<string, unknown>[]) =>
  messages.map((message) => message.event as { type?: string; content?: string; isError?: boolean } | undefined).filter((event) => event?.type === "tool_ended");

/** The links as a new watcher of the profile sees them. */
async function linksNow(): Promise<WorkTicket[]> {
  const fresh = await openRecorded(relay.port, "/integrations/watch");
  const state = await fresh.recorded.waitFor((message) => message.type === "work_tickets_state");
  fresh.socket.close();
  return state.links as WorkTicket[];
}

test("the first ticket the agent opens becomes the session's; its other calls only refresh the cache", async () => {
  const chat = await session("s-agent");
  const since = watch.recorded.mark();
  const first = await turn(chat, `look at the login bug ${issueCall("NGL-1")}`);
  const linked = (await watch.recorded.waitFor(upsertOf("s-agent"), since)).link as WorkTicket;
  assert.deepEqual({ ...linked, linkedAt: 0 }, {
    sessionId: "s-agent",
    ticket: { provider: "jira", site: FAKE_JIRA_SITE.id, key: "NGL-1", id: "10001" },
    origin: "mcp",
    evidence: "getJiraIssue",
    linkedAt: 0,
    title: "Fix the login redirect",
    lineDue: false,
  });
  // The ticket screen is cached from the agent's own read.
  await watch.recorded.waitFor((message) => jiraOf(message)?.queries.some((query) => query.query === "ticket" && query.param === "NGL-1" && query.source === "turn") === true, since);
  // The session list carries it (once the session has its title).
  await list.recorded.waitFor((message) => message.type === "session_list_upsert" && message.id === "s-agent" && JSON.stringify(message.workTicket) === JSON.stringify({ provider: "jira", key: "NGL-1" }));

  const secondSince = watch.recorded.mark();
  const second = await turn(chat, `and the release notes ${issueCall("NGL-2")}`);
  await watch.recorded.waitFor((message) => jiraOf(message)?.queries.some((query) => query.query === "ticket" && query.param === "NGL-2" && query.source === "turn") === true, secondSince);
  assert.equal((await linksNow()).find((link) => link.sessionId === "s-agent")?.ticket.key, "NGL-1");
  assert.ok(!watch.recorded.messages.slice(secondSince).some(upsertOf("s-agent")), "the link did not change");

  // Both calls reached the agent as the server answered them.
  for (const [messages, key] of [[first, "NGL-1"], [second, "NGL-2"]] as const) {
    const [ended] = toolEnds(messages);
    assert.equal(ended?.isError, false);
    const issue = JSON.parse(ended?.content ?? "{}") as { key?: string; fields?: { description?: string; comment?: { comments: unknown[] } } };
    assert.equal(issue.key, key);
    assert.ok((issue.fields?.description?.length ?? 0) > 4000, "the description is not cut for the agent");
    assert.equal(issue.fields?.comment?.comments.length, 12);
  }
});

test("a search the agent runs adds no ticket the cache did not have", async () => {
  const chat = await session("s-search");
  await turn(chat, `what is there in ABC ${mcpCallMarker(SERVER, "searchJiraIssuesUsingJql", { cloudId: FAKE_JIRA_SITE.id, jql: 'project = "ABC" ORDER BY updated DESC' })}`);
  const fresh = await openRecorded(relay.port, "/integrations/watch");
  const state = jiraOf(await fresh.recorded.waitFor((message) => message.type === "integrations_state"));
  fresh.socket.close();
  const mine = state?.queries.find((query) => query.query === "mine" && query.param === null);
  assert.deepEqual(mine?.query === "mine" ? mine.items?.map((item) => item.key) : undefined, ["NGL-2", "NGL-1"]);
  assert.ok(!state?.queries.some((query) => query.query === "ticket" && query.param === "ABC-7"));
  assert.ok(!(await linksNow()).some((link) => link.sessionId === "s-search"));
});

test("a key in the text links nothing; a person's link holds against the agent's calls, and unlink frees it", async () => {
  const chat = await session("s-person");
  // A `#` chip reaches the relay as the key in the text, nothing more.
  await turn(chat, "is NGL-4 still flaky?");
  assert.ok(!(await linksNow()).some((link) => link.sessionId === "s-person"));

  let since = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "work_ticket", sessionId: "s-person", action: "link", ticket: { provider: "jira", site: FAKE_JIRA_SITE.id, key: "NGL-4" } }));
  assert.equal((await watch.recorded.waitFor(resultOf("s-person"), since)).ok, true);
  const linked = (await watch.recorded.waitFor(upsertOf("s-person"), since)).link as WorkTicket;
  assert.deepEqual([linked.origin, linked.ticket.key, linked.lineDue], ["manual", "NGL-4", true]);
  await list.recorded.waitFor((message) => message.type === "session_list_upsert" && message.id === "s-person" && (message.workTicket as { key?: string } | undefined)?.key === "NGL-4");

  // The agent opens another ticket: the person's link stays.
  await turn(chat, `check ${issueCall("NGL-1")}`);
  assert.equal((await linksNow()).find((link) => link.sessionId === "s-person")?.origin, "manual");

  since = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "work_ticket", sessionId: "s-person", action: "link", ticket: { provider: "jira", site: FAKE_JIRA_SITE.id, key: "NGL-2" } }));
  assert.equal((await watch.recorded.waitFor(resultOf("s-person"), since)).error, "conflict");
  watch.socket.send(JSON.stringify({ type: "work_ticket", sessionId: "no-such-session", action: "link", ticket: { provider: "jira", site: FAKE_JIRA_SITE.id, key: "NGL-2" } }));
  assert.equal((await watch.recorded.waitFor(resultOf("no-such-session"), since)).error, "no_session");

  since = watch.recorded.mark();
  const listSince = list.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "work_ticket", sessionId: "s-person", action: "unlink" }));
  await watch.recorded.waitFor((message) => message.type === "work_ticket_removed" && message.sessionId === "s-person", since);
  const cleared = await list.recorded.waitFor((message) => message.type === "session_list_upsert" && message.id === "s-person", listSince);
  assert.equal(cleared.workTicket, undefined);

  // Free again: the agent's next ticket is the session's.
  since = watch.recorded.mark();
  await turn(chat, `then ${issueCall("NGL-2")}`);
  assert.equal(((await watch.recorded.waitFor(upsertOf("s-person"), since)).link as WorkTicket).ticket.key, "NGL-2");
});

test("deleting a session drops its link, on the socket and on disk", async () => {
  assert.ok((await linksNow()).some((link) => link.sessionId === "s-agent"));
  const since = watch.recorded.mark();
  const deleted = await fetch(`http://127.0.0.1:${relay.port}/sessions/delete`, { method: "POST", body: JSON.stringify({ id: "s-agent" }) });
  assert.equal(deleted.status, 200);
  await watch.recorded.waitFor((message) => message.type === "work_ticket_removed" && message.sessionId === "s-agent", since);
  const onDisk = JSON.parse(readFileSync(join(work, "sessions-ticket-links.json"), "utf8")) as { version: number; bySession: Record<string, unknown> };
  assert.equal(onDisk.version, 1);
  assert.ok(!("s-agent" in onDisk.bySession));
  assert.ok("s-person" in onDisk.bySession);
});
