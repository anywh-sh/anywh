// Atlassian's MCP server, as the fake `claude` (`mcp_call`) and the fake
// `codex app-server` (`mcpServer/tool/call`) answer a direct call of one of
// its tools: the `CallToolResult` the real server sends, with redacted data.
// Not a fifth mock boundary — it is what those two fakes say their server
// answered, the same way they already answer `mcp_status` from a file.
//
// Shapes: `searchJiraIssuesUsingJql` as recorded through Claude Code 2.1.303
// (`structuredContent` = `{issues: {nodes, webUrl, pageInfo}}`, the text
// block the same JSON); a node's fields as recorded (`summary`, `status`
// with its category, `priority`, `updated`). SYNTHETIC, following Jira's
// REST shapes: `getAccessibleAtlassianResources` (the site list) and
// `getJiraIssue` (the issue with its comments). All values are invented.
//
// Driven by env (read at each call, so a test can switch it mid-run):
//   FAKE_ATLASSIAN_MODE_FILE - its text: `ok` (default), `bad_token` (the
//     reduced catalog of a bad token: every Jira tool "not found") or
//     `unauthorized` (an error result with an MCP `WWW-Authenticate`).
//   FAKE_ATLASSIAN_PAGE_SIZE - caps `maxResults` (default 50), so a short
//     fixture still has a second page.
//   FAKE_ATLASSIAN_CALLS_FILE - every call appends one JSON line
//     `{via, server, tool, arguments, isolated}`.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export const FAKE_SITE = { id: "00000000-0000-4000-8000-0000000000a1", url: "https://example-team.atlassian.net", name: "example-team" };

const STATUS = {
  todo: { name: "To Do", statusCategory: { key: "new", colorName: "blue-gray", name: "To Do" } },
  doing: { name: "In Progress", statusCategory: { key: "indeterminate", colorName: "yellow", name: "In Progress" } },
  done: { name: "Done", statusCategory: { key: "done", colorName: "green", name: "Done" } },
};

const issue = (key, id, summary, status, priority, updated) => ({ key, id, summary, status, priority, updated });

// Newest change first is the order the JQL asks for; kept unsorted here on
// purpose.
const ISSUES = [
  issue("NGL-1", "10001", "Fix the login redirect", "doing", "High", "2026-11-05T09:00:00.000-0300"),
  issue("NGL-2", "10002", "Write the release notes", "todo", "Medium", "2026-11-06T09:00:00.000-0300"),
  issue("NGL-3", "10003", "Already shipped", "done", "Low", "2026-11-06T10:00:00.000-0300"),
  issue("ABC-7", "10007", "Rotate the staging keys", "todo", "Highest", "2026-11-04T09:00:00.000-0300"),
  issue("NGL-4", "10004", "Flaky upload test", "todo", "Low", "2026-11-03T09:00:00.000-0300"),
];

function node(entry) {
  return {
    id: entry.id,
    key: entry.key,
    self: `https://api.atlassian.com/ex/jira/${FAKE_SITE.id}/rest/api/3/issue/${entry.id}`,
    expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
    webUrl: `${FAKE_SITE.url}/browse/${entry.key}`,
    fields: {
      summary: entry.summary,
      status: STATUS[entry.status],
      priority: { name: entry.priority, iconUrl: `${FAKE_SITE.url}/images/icons/priorities/${entry.priority.toLowerCase()}.svg` },
      issuetype: { name: "Task" },
      project: { key: entry.key.split("-")[0], name: `Project ${entry.key.split("-")[0]}` },
      updated: entry.updated,
    },
  };
}

const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false });
const textResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
const errorResult = (text) => ({ content: [{ type: "text", text }], isError: true });

const JIRA_TOOLS = new Set(["getAccessibleAtlassianResources", "searchJiraIssuesUsingJql", "getJiraIssue", "atlassianUserInfo", "getVisibleJiraProjects"]);

function search(args) {
  const jql = String(args?.jql ?? "");
  const project = /project = "([A-Z][A-Z0-9]+)"/.exec(jql)?.[1];
  let issues = ISSUES.filter((entry) => !/statusCategory != Done/.test(jql) || entry.status !== "done").filter((entry) => !project || entry.key.startsWith(`${project}-`));
  if (/ORDER BY updated DESC/.test(jql)) issues = [...issues].sort((a, b) => Date.parse(b.updated.replace(/(\d{2})(\d{2})$/, "$1:$2")) - Date.parse(a.updated.replace(/(\d{2})(\d{2})$/, "$1:$2")));
  const size = Math.min(Number(args?.maxResults ?? 50), Number(process.env.FAKE_ATLASSIAN_PAGE_SIZE ?? 50));
  const offset = typeof args?.nextPageToken === "string" ? Number(args.nextPageToken.replace(/^cursor-/, "")) : 0;
  const page = issues.slice(offset, offset + size);
  const hasNextPage = offset + size < issues.length;
  return result({
    issues: { nodes: page.map(node), webUrl: `${FAKE_SITE.url}/issues/?jql=${encodeURIComponent(jql)}`, pageInfo: { hasNextPage, ...(hasNextPage ? { endCursor: `cursor-${offset + size}` } : {}) } },
    context: { cloudId: args?.cloudId },
  });
}

function getIssue(args) {
  const entry = ISSUES.find((candidate) => candidate.key === args?.issueIdOrKey || candidate.id === args?.issueIdOrKey);
  if (!entry) return errorResult("Issue does not exist or you do not have permission to see it.");
  const base = node(entry);
  const comments = Array.from({ length: 12 }, (_, index) => ({
    id: String(20000 + index),
    author: { displayName: index % 2 === 0 ? "Person One" : "Person Two" },
    body: `Comment ${index + 1} on ${entry.key}`,
    created: `2026-11-0${1 + Math.floor(index / 4)}T1${index % 4}:00:00.000-0300`,
  }));
  return result({ ...base, fields: { ...base.fields, description: `## ${entry.summary}\n\n${"Steps to reproduce. ".repeat(300)}`, comment: { comments, total: comments.length, maxResults: comments.length, startAt: 0 } } });
}

/** The `CallToolResult` for `tool` of the official Atlassian server. */
export function answerAtlassianTool(via, server, tool, args, { isolated = false } = {}) {
  if (process.env.FAKE_ATLASSIAN_CALLS_FILE) appendFileSync(process.env.FAKE_ATLASSIAN_CALLS_FILE, `${JSON.stringify({ via, server, tool, arguments: args ?? null, isolated })}\n`);
  const modeFile = process.env.FAKE_ATLASSIAN_MODE_FILE;
  const mode = modeFile && existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "ok";
  if (mode === "unauthorized") {
    return { content: [{ type: "text", text: "Authentication required" }], isError: true, _meta: { "mcp/www_authenticate": ['Bearer error="invalid_token"'] } };
  }
  if (mode === "bad_token" || !JIRA_TOOLS.has(tool)) return errorResult(`MCP error -32602: Tool ${tool} not found`);
  switch (tool) {
    case "getAccessibleAtlassianResources":
      return textResult([{ ...FAKE_SITE, scopes: ["read:jira-work", "read:jira-user", "write:jira-work"], avatarUrl: `${FAKE_SITE.url}/avatar.png` }]);
    case "searchJiraIssuesUsingJql":
      return search(args);
    case "getJiraIssue":
      return getIssue(args);
    default:
      return errorResult(`MCP error -32602: Tool ${tool} not found`);
  }
}

/** Whether a server, as the fakes' inventory files declare it, is the
 * official Atlassian one. */
export function isAtlassianServer(declared) {
  const url = declared?.config?.url ?? declared?.transport?.url ?? "";
  return declared?.serverInfo?.name === "atlassian-mcp-server" || /^https:\/\/mcp\.atlassian\.com\//.test(url);
}
