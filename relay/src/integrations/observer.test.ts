// The ticket observer over a stream of turn events written here, with
// in-memory sinks. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../protocol/agent-event.js";
import { TicketObserver } from "./observer.js";
import { TicketLinks } from "./ticketLinks.js";
import type { IntegrationSite, TicketDetail, TicketRow } from "./types.js";

const SITE: IntegrationSite = { id: "00000000-0000-4000-8000-000000000001", url: "https://example-site.atlassian.net", name: "example-site" };
const SERVER = "claude_ai_Atlassian";

function issue(key: string, summary = `Title of ${key}`) {
  return {
    id: `1${key.replace(/\D/g, "")}`,
    key,
    webUrl: `${SITE.url}/browse/${key}`,
    fields: { summary, status: { name: "To Do", statusCategory: { key: "new" } }, project: { key: key.split("-")[0] }, updated: "2026-11-05T09:00:00.000-0300", description: null, comment: { comments: [] } },
  };
}

/** A tool call as the CLI reports it: Claude's flattened text of the result. */
function call(id: string, tool: string, input: Record<string, unknown>, result: unknown, options: { server?: string; isError?: boolean } = {}): AgentEvent[] {
  return [
    { type: "tool_started", toolUseId: id, name: `mcp__${options.server ?? SERVER}__${tool}`, kind: "mcp", input, subject: { kind: "mcp", server: options.server ?? SERVER, tool } },
    { type: "tool_ended", toolUseId: id, content: typeof result === "string" ? result : JSON.stringify(result), isError: options.isError ?? false },
  ];
}

function harness(options: { siteUnknown?: true; mayLink?: boolean } = {}) {
  const links = new TicketLinks();
  const ingested: { detail?: TicketDetail; rows?: readonly TicketRow[] }[] = [];
  const observer = new TicketObserver({
    identify: (runtimeId, server) => (runtimeId === "claude" && server === SERVER ? { integrationId: "jira", provider: "jira", ...(options.siteUnknown ? {} : { site: SITE }) } : undefined),
    ingest: (_id, observed) => ingested.push(observed),
    links,
    mayLink: () => options.mayLink ?? true,
  });
  const feed = (sessionId: string, events: AgentEvent[], runtimeId = "claude") => {
    for (const event of events) observer.observe(sessionId, runtimeId, event);
  };
  return { links, ingested, feed };
}

test("the first ticket the agent opens becomes the session's; the next ones only refresh the cache", () => {
  const { links, ingested, feed } = harness();
  feed("s1", call("t1", "getJiraIssue", { cloudId: SITE.id, issueIdOrKey: "NGL-1" }, issue("NGL-1", "Fix the login")));
  assert.deepEqual(links.get("s1") && { ...links.get("s1"), linkedAt: 0 }, {
    sessionId: "s1",
    ticket: { provider: "jira", site: SITE.id, key: "NGL-1", id: "11" },
    origin: "mcp",
    evidence: "getJiraIssue",
    linkedAt: 0,
    title: "Fix the login",
    lineDue: false,
  });
  feed("s1", call("t2", "getJiraIssue", { cloudId: SITE.id, issueIdOrKey: "NGL-2" }, issue("NGL-2")));
  assert.equal(links.get("s1")?.ticket.key, "NGL-1");
  assert.deepEqual(ingested.map((observed) => observed.detail?.key), ["NGL-1", "NGL-2"]);
});

test("calls are paired by toolUseId across sessions and interleaved calls", () => {
  const { links, feed } = harness();
  const [startA, endA] = call("a", "getJiraIssue", { cloudId: SITE.id, issueIdOrKey: "NGL-1" }, issue("NGL-1"));
  const [startB, endB] = call("b", "getJiraIssue", { cloudId: SITE.id, issueIdOrKey: "NGL-2" }, issue("NGL-2"));
  feed("s1", [startA]);
  feed("s2", [startB]);
  feed("s2", [endB]);
  feed("s1", [endA]);
  assert.equal(links.get("s1")?.ticket.key, "NGL-1");
  assert.equal(links.get("s2")?.ticket.key, "NGL-2");
  // An end with no start of this session is nothing.
  feed("s3", [endA]);
  assert.equal(links.get("s3"), undefined);
});

test("a failed call, a non-Jira server, a relay bridge or a search opens nothing", () => {
  const { links, ingested, feed } = harness();
  feed("s1", call("e", "getJiraIssue", { cloudId: SITE.id, issueIdOrKey: "NGL-1" }, "Issue does not exist", { isError: true }));
  feed("s1", call("o", "getJiraIssue", { cloudId: SITE.id, issueIdOrKey: "NGL-1" }, issue("NGL-1"), { server: "other" }));
  feed("s1", call("r", "getJiraIssue", { issueIdOrKey: "NGL-1" }, issue("NGL-1"), { server: "anywh-room" }));
  feed("s1", call("c", "getJiraIssue", { cloudId: SITE.id, issueIdOrKey: "NGL-1" }, issue("NGL-1")), "codex");
  feed("s1", call("s", "searchJiraIssuesUsingJql", { cloudId: SITE.id, jql: "project = NGL" }, { issues: { nodes: [issue("NGL-4")], pageInfo: { hasNextPage: false } } }));
  assert.equal(links.get("s1"), undefined);
  assert.deepEqual(ingested.map((observed) => observed.rows?.map((row) => row.key)), [["NGL-4"]]);
});

test("a session that has a ticket keeps it; a principal is never given one", () => {
  const { links, feed } = harness();
  links.link("s1", { provider: "jira", site: SITE.id, key: "NGL-9" }, "manual");
  feed("s1", call("t", "getJiraIssue", { cloudId: SITE.id, issueIdOrKey: "NGL-1" }, issue("NGL-1")));
  assert.equal(links.get("s1")?.ticket.key, "NGL-9");

  const principal = harness({ mayLink: false });
  principal.feed("p", call("t", "getJiraIssue", { cloudId: SITE.id, issueIdOrKey: "NGL-1" }, issue("NGL-1")));
  assert.equal(principal.links.get("p"), undefined);
  assert.equal(principal.ingested.length, 1);
});

test("Codex's whole CallToolResult, a numeric id, a change tool, and a site the relay never read", () => {
  const { links, ingested, feed } = harness({ siteUnknown: true });
  const codexResult = { content: [{ type: "text", text: JSON.stringify(issue("ABC-7")) }], structuredContent: issue("ABC-7") };
  feed("s1", call("t", "getJiraIssue", { cloudId: "https://other.atlassian.net", issueIdOrKey: "10007" }, codexResult));
  assert.deepEqual(links.get("s1")?.ticket, { provider: "jira", site: "https://other.atlassian.net", key: "ABC-7", id: "17" });
  // The row's address is the one the server gave.
  assert.equal(ingested[0].detail?.url, `${SITE.url}/browse/ABC-7`);

  // A comment's result is not the ticket: the key comes from the input.
  feed("s2", call("c", "addCommentToJiraIssue", { cloudId: SITE.id, issueIdOrKey: "NGL-3", commentBody: "done" }, { id: "1" }));
  assert.equal(links.get("s2")?.ticket.key, "NGL-3");
  assert.equal(links.get("s2")?.evidence, "addCommentToJiraIssue");
  assert.equal(ingested.length, 1);
});
