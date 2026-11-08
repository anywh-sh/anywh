// Jira, as read through Atlassian's MCP server: which tools the relay may
// call, the arguments it calls them with, and how their results become
// `TicketRow`/`TicketDetail`. Data and pure functions only — calling is the
// reader's (integrations/reader.ts); a second tracker is another file with
// the same shape.
//
// Read-only by construction: a closed allowlist of three tools, an explicit
// denylist for the ones that cost the person something (`search` spends
// Rovo credits, `getTeamworkGraph*` too), and any tool the server does not
// itself mark read-only is refused before the call is made.
//
// Pure.
import { TICKET_KEY_PATTERN, type McpToolInfo, type IntegrationQueryError, type IntegrationSite, type TicketComment, type TicketDetail, type TicketRow, type TicketStatusCategory } from "../types.js";
import { PROJECT_KEY_PATTERN } from "../store.js";
import type { ToolCallOutcome } from "../toolResult.js";

export const JIRA_TOOLS = {
  /** The sites the signed-in person reaches, with their `cloudId`. */
  resources: "getAccessibleAtlassianResources",
  search: "searchJiraIssuesUsingJql",
  issue: "getJiraIssue",
} as const;

export type JiraTool = (typeof JIRA_TOOLS)[keyof typeof JIRA_TOOLS];

const ALLOWED: ReadonlySet<string> = new Set(Object.values(JIRA_TOOLS));
/** Never called, whatever the allowlist says. */
const DENIED: readonly RegExp[] = [/^search$/, /^getTeamworkGraph/, /^fetch$/];

/** What the relay tells Atlassian the call is for: a card of a Jira UI, not
 * the model. */
const ACTION_SOURCE = "jira_mcp_card";
export const JIRA_PAGE_SIZE = 50;
export const DESCRIPTION_LIMIT = 4000;
export const COMMENT_LIMIT = 1000;
export const COMMENTS_KEPT = 10;

const LIST_FIELDS = ["summary", "status", "priority", "issuetype", "project", "updated"];
const DETAIL_FIELDS = ["summary", "description", "priority", "status", "comment", "issuetype", "project", "updated"];

export type JiraToolRefusal = "not_allowed" | "denied" | "not_served" | "not_read_only" | "catalog_unknown";

/** A call refused before it was made. */
export class JiraToolRefused extends Error {
  constructor(
    readonly tool: string,
    readonly reason: JiraToolRefusal,
  ) {
    super(`jira: refused to call ${tool} (${reason})`);
    this.name = "JiraToolRefused";
  }
}

/** Throws unless `tool` is one of the allowlist, not denied, and served by
 * the server as read-only (`catalog`: the server's tools as the inventory
 * saw them). */
export function assertJiraToolCallable(tool: string, catalog: readonly McpToolInfo[] | undefined): asserts tool is JiraTool {
  if (DENIED.some((pattern) => pattern.test(tool))) throw new JiraToolRefused(tool, "denied");
  if (!ALLOWED.has(tool)) throw new JiraToolRefused(tool, "not_allowed");
  if (!catalog) throw new JiraToolRefused(tool, "catalog_unknown");
  const served = catalog.find((info) => info.name === tool);
  if (!served) throw new JiraToolRefused(tool, "not_served");
  if (served.readOnly !== true) throw new JiraToolRefused(tool, "not_read_only");
}

/** The tickets assigned to the signed-in person that are not done, newest
 * change first; one project when `project` is set. */
export function mineJql(project: string | null): string {
  if (project !== null && !PROJECT_KEY_PATTERN.test(project)) throw new Error(`jira: not a project key: ${project}`);
  const scope = project === null ? "" : ` AND project = "${project}"`;
  return `assignee = currentUser() AND statusCategory != Done${scope} ORDER BY updated DESC`;
}

export function resourcesArgs(): Record<string, unknown> {
  return {};
}

export function searchArgs(cloudId: string, project: string | null, pageToken?: string): Record<string, unknown> {
  return {
    cloudId,
    jql: mineJql(project),
    fields: LIST_FIELDS,
    maxResults: JIRA_PAGE_SIZE,
    ...(pageToken ? { nextPageToken: pageToken } : {}),
    actionSource: ACTION_SOURCE,
  };
}

export function issueArgs(cloudId: string, key: string): Record<string, unknown> {
  return { cloudId, issueIdOrKey: key, fields: DETAIL_FIELDS, responseContentFormat: "markdown", updateHistory: false, actionSource: ACTION_SOURCE };
}

// --- results -----------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** The first site that has Jira, else the first one. */
export function parseResources(value: unknown): IntegrationSite | undefined {
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.resources) ? value.resources : [];
  const sites = list
    .filter((site): site is Record<string, unknown> => isRecord(site) && stringOf(site.id) !== undefined && stringOf(site.url) !== undefined)
    .map((site) => ({ site: { id: site.id as string, url: (site.url as string).replace(/\/+$/, ""), name: stringOf(site.name) ?? (site.url as string) }, scopes: Array.isArray(site.scopes) ? site.scopes : [] }));
  const withJira = sites.find(({ scopes }) => scopes.some((scope) => typeof scope === "string" && scope.includes("jira")));
  return (withJira ?? sites[0])?.site;
}

function categoryOf(status: Record<string, unknown>): TicketStatusCategory {
  const category = isRecord(status.statusCategory) ? status.statusCategory.key : undefined;
  if (category === "done") return "done";
  if (category === "indeterminate") return "doing";
  return "todo";
}

/** Jira writes offsets as `-0300`; `Date.parse` wants `-03:00`. */
function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(time) ? time : undefined;
}

function rowOf(issue: unknown, site: IntegrationSite): TicketRow | undefined {
  if (!isRecord(issue) || !isRecord(issue.fields)) return undefined;
  const key = stringOf(issue.key);
  if (!key) return undefined;
  const { fields } = issue;
  const status = isRecord(fields.status) ? fields.status : {};
  const project = isRecord(fields.project) ? stringOf(fields.project.key) : undefined;
  const priority = isRecord(fields.priority) ? stringOf(fields.priority.name) : undefined;
  return {
    key,
    id: stringOf(issue.id) ?? key,
    title: stringOf(fields.summary) ?? key,
    statusCategory: categoryOf(status),
    statusLabel: stringOf(status.name) ?? "",
    ...(priority ? { priority } : {}),
    project: project ?? key.slice(0, key.lastIndexOf("-")),
    updatedAt: timeOf(fields.updated) ?? 0,
    url: stringOf(issue.webUrl) ?? `${site.url}/browse/${key}`,
  };
}

/** One page of `searchJiraIssuesUsingJql`: the Atlassian server's own shape
 * (`{issues: {nodes, pageInfo: {hasNextPage, endCursor}}}`), or Jira's REST
 * one (`{issues: [...], nextPageToken, isLast}`). `undefined` for neither. */
export function parseSearch(value: unknown, site: IntegrationSite): { items: TicketRow[]; nextPageToken?: string } | undefined {
  const page = searchPage(value);
  if (!page) return undefined;
  const items = page.nodes.map((node) => rowOf(node, site)).filter((row): row is TicketRow => row !== undefined);
  return { items, ...(page.next ? { nextPageToken: page.next } : {}) };
}

function searchPage(value: unknown): { nodes: unknown[]; next?: string } | undefined {
  if (!isRecord(value)) return undefined;
  let nodes: unknown[];
  let next: string | undefined;
  if (isRecord(value.issues) && Array.isArray(value.issues.nodes)) {
    nodes = value.issues.nodes;
    const page = isRecord(value.issues.pageInfo) ? value.issues.pageInfo : {};
    next = page.hasNextPage === true ? stringOf(page.endCursor) : undefined;
  } else if (Array.isArray(value.issues)) {
    nodes = value.issues;
    next = value.isLast === true ? undefined : stringOf(value.nextPageToken);
  } else {
    return undefined;
  }
  return { nodes, ...(next ? { next } : {}) };
}

/** Whether an issue the agent read carries what a cached row shows — the
 * agent picks its own `fields`, and a row built from fewer would show a
 * done ticket as to do, untitled, never updated. */
function hasRowFields(issue: unknown): boolean {
  if (!isRecord(issue) || !isRecord(issue.fields)) return false;
  const { fields } = issue;
  return typeof fields.summary === "string" && isRecord(fields.status) && isRecord(fields.status.statusCategory) && timeOf(fields.updated) !== undefined;
}

/** Whether it also carries what a ticket screen shows. */
function hasDetailFields(issue: unknown): boolean {
  return hasRowFields(issue) && isRecord(issue) && isRecord(issue.fields) && "description" in issue.fields && "comment" in issue.fields;
}

/** The issue a single-ticket tool answered with: bare, wrapped in `{issue}`,
 * or — Atlassian's own server — in the search page's envelope
 * (`{issues: {nodes: [issue]}, context}`). */
function issueOf(value: unknown): unknown {
  if (!isRecord(value) || isRecord(value.fields)) return value;
  if (isRecord(value.issue)) return value.issue;
  const nodes = isRecord(value.issues) ? value.issues.nodes : undefined;
  if (Array.isArray(nodes) && nodes.length === 1) return nodes[0];
  return value;
}

/** Text of an Atlassian Document Format node, for a server that answered in
 * ADF despite being asked for markdown. */
function adfText(node: unknown): string {
  if (!isRecord(node)) return "";
  if (typeof node.text === "string") return node.text;
  const children = Array.isArray(node.content) ? node.content.map(adfText) : [];
  const block = node.type === "paragraph" || node.type === "heading" || node.type === "listItem" || node.type === "codeBlock";
  return children.join("") + (block ? "\n\n" : "");
}

function markdownOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return adfText(value).trim() || undefined;
  return undefined;
}

const truncate = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}…` : text);

function commentsOf(raw: unknown): TicketComment[] {
  const list = isRecord(raw) && Array.isArray(raw.comments) ? raw.comments : Array.isArray(raw) ? raw : [];
  const comments = list
    .filter(isRecord)
    .map((comment): TicketComment | undefined => {
      const createdAt = timeOf(comment.created);
      const body = markdownOf(comment.body);
      if (createdAt === undefined || body === undefined) return undefined;
      const author = isRecord(comment.author) ? (stringOf(comment.author.displayName) ?? "") : "";
      return { author, createdAt, bodyMd: truncate(body, COMMENT_LIMIT) };
    })
    .filter((comment): comment is TicketComment => comment !== undefined)
    .sort((a, b) => a.createdAt - b.createdAt);
  // The most recent ones, oldest first.
  return comments.slice(-COMMENTS_KEPT);
}

/** `getJiraIssue`'s issue (also when wrapped, see `issueOf`). */
export function parseIssue(value: unknown, site: IntegrationSite): TicketDetail | undefined {
  const issue = issueOf(value);
  const row = rowOf(issue, site);
  if (!row || !isRecord(issue) || !isRecord(issue.fields)) return undefined;
  const description = markdownOf(issue.fields.description);
  return { ...row, ...(description ? { descriptionMd: truncate(description, DESCRIPTION_LIMIT) } : {}), comments: commentsOf(issue.fields.comment) };
}

// --- the agent's own calls -----------------------------------------------------

/** The agent's calls about one ticket: the first that succeeds in a session
 * with no ticket gives the session that ticket. */
const SINGLE_TICKET_TOOLS: ReadonlySet<string> = new Set(["getJiraIssue", "editJiraIssue", "transitionJiraIssue", "addCommentToJiraIssue", "addWorklogToJiraIssue"]);
/** Of those, the ones whose result is the ticket itself. */
const TICKET_RESULT_TOOLS: ReadonlySet<string> = new Set(["getJiraIssue", "editJiraIssue", "transitionJiraIssue"]);

/** What a successful call the agent made tells about tickets. */
export interface JiraObservation {
  /** The call was about this one ticket. */
  readonly key?: string;
  /** The ticket screen as read (`getJiraIssue`). */
  readonly detail?: TicketDetail;
  /** Rows to refresh where they are already cached; never new ones. */
  readonly rows?: TicketRow[];
}

/** `undefined` for a call that says nothing about tickets. What the call
 * read with fewer fields than the cache shows is left out of `rows` and
 * `detail` (a ticket screen read without its description or comments
 * refreshes only its row). */
export function observeJiraCall(tool: string, input: Record<string, unknown>, value: unknown, site: IntegrationSite): JiraObservation | undefined {
  if (tool === JIRA_TOOLS.search) {
    const page = searchPage(value);
    if (!page) return undefined;
    return { rows: page.nodes.filter(hasRowFields).map((node) => rowOf(node, site)).filter((row): row is TicketRow => row !== undefined) };
  }
  if (!SINGLE_TICKET_TOOLS.has(tool)) return undefined;
  const parsed = TICKET_RESULT_TOOLS.has(tool) ? parseIssue(value, site) : undefined;
  const issue = issueOf(value);
  const asked = typeof input.issueIdOrKey === "string" && TICKET_KEY_PATTERN.test(input.issueIdOrKey) ? input.issueIdOrKey : undefined;
  // A numeric id in the input: the key comes from the result.
  const key = asked ?? parsed?.key;
  if (!key) return undefined;
  if (!parsed || parsed.key !== key || !hasRowFields(issue)) return { key };
  if (tool === JIRA_TOOLS.issue && hasDetailFields(issue)) return { key, detail: parsed };
  const { descriptionMd: _description, comments: _comments, ...row } = parsed;
  return { key, rows: [row] };
}

// --- failures ----------------------------------------------------------------

const AUTH_PATTERN = /auth(entication)? required|unauthori[sz]ed|invalid_token|not logged in|failed to refresh oauth tokens|session expired|authenticationRequired|reauthenticationRequired|needs-auth/i;
const TOOL_NOT_FOUND = /tool .* not found/i;

/** A failed call as the query's status: a missing sign-in is `needs_auth`,
 * whether the server said so (a challenge, an auth message) or showed it —
 * Atlassian's own server with a bad token serves a catalog without Jira
 * tools, so a Jira tool "not found" there means a sign-in, not a bug. */
export function classifyJiraFailure(outcome: Extract<ToolCallOutcome, { ok: false }>, official: boolean): { status: "needs_auth" | "error"; error: IntegrationQueryError } {
  const message = outcome.message;
  if (outcome.authChallenge || AUTH_PATTERN.test(message) || (official && TOOL_NOT_FOUND.test(message))) {
    return { status: "needs_auth", error: { kind: "tool", message } };
  }
  if (outcome.kind === "parse") return { status: "error", error: { kind: "parse", message } };
  if (outcome.kind === "transport" && outcome.unreachable) return { status: "error", error: { kind: "network", message } };
  return { status: "error", error: { kind: "tool", message } };
}
