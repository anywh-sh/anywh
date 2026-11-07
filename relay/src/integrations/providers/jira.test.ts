// The Jira adapter: what may be called, with which arguments, and what a
// result becomes. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readCallToolResult, transportFailure } from "../toolResult.js";
import type { McpToolInfo } from "../types.js";
import {
  COMMENTS_KEPT,
  COMMENT_LIMIT,
  DESCRIPTION_LIMIT,
  JIRA_PAGE_SIZE,
  JiraToolRefused,
  assertJiraToolCallable,
  classifyJiraFailure,
  issueArgs,
  mineJql,
  parseIssue,
  parseResources,
  parseSearch,
  searchArgs,
} from "./jira.js";

const SITE = { id: "cloud-1", url: "https://example-team.atlassian.net", name: "example-team" };
// The official server's catalog as the inventory records it (subset).
const CATALOG: McpToolInfo[] = [
  { name: "getAccessibleAtlassianResources", readOnly: true },
  { name: "searchJiraIssuesUsingJql", readOnly: true },
  { name: "getJiraIssue", readOnly: true },
  { name: "editJiraIssue", readOnly: false },
  { name: "getTeamworkGraphContext", readOnly: true },
  { name: "search", readOnly: true },
  { name: "fetch", readOnly: true },
];

const refusal = (run: () => void): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof JiraToolRefused);
    return error.reason;
  }
};

test("only the three read tools pass; Rovo search, the teamwork graph and anything not read-only are refused", () => {
  for (const tool of ["getAccessibleAtlassianResources", "searchJiraIssuesUsingJql", "getJiraIssue"]) assert.equal(refusal(() => assertJiraToolCallable(tool, CATALOG)), undefined);
  assert.equal(refusal(() => assertJiraToolCallable("search", CATALOG)), "denied");
  assert.equal(refusal(() => assertJiraToolCallable("fetch", CATALOG)), "denied");
  assert.equal(refusal(() => assertJiraToolCallable("getTeamworkGraphContext", CATALOG)), "denied");
  assert.equal(refusal(() => assertJiraToolCallable("getTeamworkGraphObject", CATALOG)), "denied");
  assert.equal(refusal(() => assertJiraToolCallable("editJiraIssue", CATALOG)), "not_allowed");
  // An allowed name the server serves without the read-only mark.
  assert.equal(refusal(() => assertJiraToolCallable("getJiraIssue", [{ name: "getJiraIssue" }])), "not_read_only");
  assert.equal(refusal(() => assertJiraToolCallable("getJiraIssue", [{ name: "getJiraIssue", readOnly: false }])), "not_read_only");
  assert.equal(refusal(() => assertJiraToolCallable("getJiraIssue", [{ name: "getTeamworkGraphContext", readOnly: true }])), "not_served");
  assert.equal(refusal(() => assertJiraToolCallable("getJiraIssue", undefined)), "catalog_unknown");
});

test("the list's JQL: assigned to me, not done, newest first, optionally one project", () => {
  assert.equal(mineJql(null), "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
  assert.equal(mineJql("NGL"), 'assignee = currentUser() AND statusCategory != Done AND project = "NGL" ORDER BY updated DESC');
  assert.throws(() => mineJql('NGL" OR project = "X'));
});

test("arguments say the call comes from a card, never move the person's history, and ask for markdown", () => {
  assert.deepEqual(searchArgs("cloud-1", "NGL", "cursor-2"), {
    cloudId: "cloud-1",
    jql: mineJql("NGL"),
    fields: ["summary", "status", "priority", "issuetype", "project", "updated"],
    maxResults: JIRA_PAGE_SIZE,
    nextPageToken: "cursor-2",
    actionSource: "jira_mcp_card",
  });
  assert.equal("nextPageToken" in searchArgs("cloud-1", null), false);
  const issue = issueArgs("cloud-1", "NGL-1");
  assert.equal(issue.issueIdOrKey, "NGL-1");
  assert.equal(issue.updateHistory, false);
  assert.equal(issue.responseContentFormat, "markdown");
  assert.equal(issue.actionSource, "jira_mcp_card");
  assert.ok((issue.fields as string[]).includes("comment"));
});

test("the site with Jira is picked from the resources", () => {
  const sites = [
    { id: "c-conf", url: "https://wiki.example.net/", name: "wiki", scopes: ["read:confluence-content.all"] },
    { id: "c-jira", url: "https://example-team.atlassian.net", name: "example-team", scopes: ["read:jira-work"] },
  ];
  assert.deepEqual(parseResources(sites), { id: "c-jira", url: "https://example-team.atlassian.net", name: "example-team" });
  assert.deepEqual(parseResources([sites[0]]), { id: "c-conf", url: "https://wiki.example.net", name: "wiki" });
  assert.equal(parseResources([]), undefined);
  assert.equal(parseResources("nope"), undefined);
});

const node = (key: string, category: string, updated = "2026-11-05T09:00:00.000-0300") => ({
  id: key.replace(/\D/g, ""),
  key,
  webUrl: `${SITE.url}/browse/${key}`,
  fields: { summary: `About ${key}`, status: { name: "Status name", statusCategory: { key: category } }, priority: { name: "High" }, project: { key: key.split("-")[0] }, updated },
});

test("a search page becomes rows, with the next page's token from either shape", () => {
  const recorded = { issues: { nodes: [node("NGL-1", "indeterminate"), node("NGL-2", "new"), { key: "broken" }], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } } };
  const page = parseSearch(recorded, SITE);
  assert.ok(page);
  assert.equal(page.nextPageToken, "cursor-2");
  assert.deepEqual(page.items[0], {
    key: "NGL-1",
    id: "1",
    title: "About NGL-1",
    statusCategory: "doing",
    statusLabel: "Status name",
    priority: "High",
    project: "NGL",
    updatedAt: Date.parse("2026-11-05T12:00:00.000Z"),
    url: `${SITE.url}/browse/NGL-1`,
  });
  assert.equal(page.items[1].statusCategory, "todo");
  assert.equal(page.items.length, 2, "a node without fields is skipped");
  const last = parseSearch({ issues: { nodes: [], pageInfo: { hasNextPage: false } } }, SITE);
  assert.deepEqual(last, { items: [] });
  const rest = parseSearch({ issues: [{ ...node("ABC-1", "done"), webUrl: undefined }], nextPageToken: "t", isLast: false }, SITE);
  assert.equal(rest?.nextPageToken, "t");
  assert.equal(rest?.items[0].statusCategory, "done");
  assert.equal(rest?.items[0].url, `${SITE.url}/browse/ABC-1`, "the URL is built when the server gives none");
  assert.equal(parseSearch({ total: 3 }, SITE), undefined);
});

test("an issue keeps its description and the most recent comments, each cut to size", () => {
  const comments = Array.from({ length: 14 }, (_, index) => ({ author: { displayName: `P${index}` }, body: index === 13 ? "x".repeat(5000) : `c${index}`, created: `2026-11-01T10:${String(index).padStart(2, "0")}:00.000+0000` }));
  const detail = parseIssue({ ...node("NGL-1", "new"), fields: { ...node("NGL-1", "new").fields, description: "d".repeat(9000), comment: { comments: [...comments].reverse() } } }, SITE);
  assert.ok(detail);
  assert.equal(detail.descriptionMd?.length, DESCRIPTION_LIMIT + 1, "cut, with an ellipsis");
  assert.equal(detail.comments.length, COMMENTS_KEPT);
  assert.deepEqual(detail.comments.map((comment) => comment.author).slice(0, 2), ["P4", "P5"], "the latest ones, oldest first");
  assert.equal(detail.comments.at(-1)?.bodyMd.length, COMMENT_LIMIT + 1);
  // A server that answered in ADF anyway.
  const adf = parseIssue({ ...node("NGL-2", "new"), fields: { ...node("NGL-2", "new").fields, description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] } } }, SITE);
  assert.equal(adf?.descriptionMd, "Hello");
  assert.deepEqual(adf?.comments, []);
  assert.equal(parseIssue({ errorMessages: ["nope"] }, SITE), undefined);
});

test("results: structuredContent first, else the text as JSON; errors keep their text, short", () => {
  assert.deepEqual(readCallToolResult({ content: [{ type: "text", text: "{}" }], structuredContent: { a: 1 } }), { ok: true, value: { a: 1 } });
  assert.deepEqual(readCallToolResult({ content: [{ type: "text", text: '[{"id":"x"}]' }] }), { ok: true, value: [{ id: "x" }] });
  assert.deepEqual(readCallToolResult({ result: { content: [{ type: "text", text: "1" }] } }), { ok: true, value: 1 });
  assert.equal(readCallToolResult({ content: [{ type: "text", text: "plain" }] }).ok, false);
  const error = readCallToolResult({ content: [{ type: "text", text: "y".repeat(1000) }], isError: true });
  assert.ok(!error.ok && error.kind === "tool" && error.message.length < 400);
});

test("a sign-in is needed: an auth challenge, an auth message, or a Jira tool 'not found' on Atlassian's own server", () => {
  const challenge = readCallToolResult({ content: [{ type: "text", text: "Authentication required" }], isError: true, _meta: { "mcp/www_authenticate": ['Bearer error="invalid_token"'] } });
  assert.ok(!challenge.ok);
  assert.equal(classifyJiraFailure(challenge, true).status, "needs_auth");
  const notFound = readCallToolResult({ content: [{ type: "text", text: "MCP error -32602: Tool getJiraIssue not found" }], isError: true });
  assert.ok(!notFound.ok);
  assert.equal(classifyJiraFailure(notFound, true).status, "needs_auth");
  assert.deepEqual(classifyJiraFailure(notFound, false), { status: "error", error: { kind: "tool", message: "MCP error -32602: Tool getJiraIssue not found" } }, "on a community server it is just an error");
  const codexNoLogin = transportFailure(new Error("failed to get client: MCP startup failed: handshaking with MCP server failed: Auth required, when send initialize request"));
  assert.ok(!codexNoLogin.ok);
  assert.equal(classifyJiraFailure(codexNoLogin, true).status, "needs_auth");
  const refresh = transportFailure(new Error("failed to refresh OAuth tokens"));
  assert.ok(!refresh.ok);
  assert.equal(classifyJiraFailure(refresh, true).status, "needs_auth");
});

test("other failures: a timeout is the network, a tool's own error is the tool's, an unreadable answer is parse", () => {
  const timeout = new Error("claude control: mcp_call timed out after 20000 ms");
  timeout.name = "ClaudeControlTimeout";
  const timedOut = transportFailure(timeout);
  assert.ok(!timedOut.ok);
  assert.equal(classifyJiraFailure(timedOut, true).error.kind, "network");
  const missing = readCallToolResult({ content: [{ type: "text", text: "Issue does not exist or you do not have permission to see it." }], isError: true });
  assert.ok(!missing.ok);
  assert.deepEqual(classifyJiraFailure(missing, true), { status: "error", error: { kind: "tool", message: "Issue does not exist or you do not have permission to see it." } });
  const unreadable = readCallToolResult({ content: [] });
  assert.ok(!unreadable.ok);
  assert.equal(classifyJiraFailure(unreadable, true).error.kind, "parse");
});
