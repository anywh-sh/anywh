// Reads an integration's queries through the MCP server picked for it: which
// CLI to go through, finding the site once, and turning each query into the
// provider's tool calls (providers/jira.ts). Calling is the
// `McpToolCaller`'s, so this file is pure orchestration.
//
// Routing: only a server the inventory says is connected is read from,
// Codex's first (its call is a method of the app-server's protocol, not an
// undocumented control request), then Claude's. A read that finds the
// server wants a sign-in, or does not serve the tools, tries the next CLI.
import { isOfficialAtlassian, type IntegrationPick } from "./match.js";
import {
  JIRA_TOOLS,
  JiraToolRefused,
  assertJiraToolCallable,
  classifyJiraFailure,
  issueArgs,
  parseIssue,
  parseResources,
  parseSearch,
  resourcesArgs,
  searchArgs,
} from "./providers/jira.js";
import type { IntegrationReadRequest, IntegrationReadResult, IntegrationReader } from "./service.js";
import type { McpToolCaller } from "./toolCaller.js";
import type { IntegrationSite, McpInventoryEntry, McpRuntimeId } from "./types.js";

const ORDER: readonly McpRuntimeId[] = ["codex", "claude"];

type Failure = Extract<IntegrationReadResult, { ok: false }> & { readonly tryNext: boolean };

export function createIntegrationReader(caller: McpToolCaller): IntegrationReader {
  return {
    async read(request, context) {
      if (request.provider !== "jira") return { ok: false, status: "error", error: { kind: "tool", message: `no reader for ${request.provider}` } };
      const candidates = ORDER.map((runtimeId) => context.picks.find((pick) => pick.runtimeId === runtimeId && pick.status === "connected")).filter(
        (pick): pick is IntegrationPick => pick !== undefined,
      );
      if (candidates.length === 0) {
        const needsAuth = context.picks.some((pick) => pick.status === "needs_auth");
        return needsAuth
          ? { ok: false, status: "needs_auth", error: { kind: "tool", message: "the server needs a sign-in" } }
          : { ok: false, status: "error", error: { kind: "network", message: "no connected server" } };
      }
      let site = context.site;
      let last: Failure | undefined;
      // Servers that turned out to want a sign-in, for the inventory.
      const needsAuth: McpInventoryEntry[] = [];
      const signedOut = () => (needsAuth.length > 0 ? { needsAuth } : {});
      for (const pick of candidates) {
        const result = await readJira(caller, pick.chosen, request, site);
        if (result.ok) return { ...result, ...signedOut() };
        if (result.status === "needs_auth") needsAuth.push(pick.chosen);
        if (result.site) site = result.site;
        last = result;
        if (!result.tryNext) break;
      }
      const { tryNext: _tryNext, ...failure } = last as Failure;
      // A site found on the way is worth keeping even if the read failed.
      return { ...failure, ...(site && site !== context.site && !failure.site ? { site } : {}), ...signedOut() };
    },
    close() {
      caller.close();
    },
  };
}

async function readJira(caller: McpToolCaller, server: McpInventoryEntry, request: IntegrationReadRequest, known: IntegrationSite | undefined): Promise<Extract<IntegrationReadResult, { ok: true }> | Failure> {
  const official = isOfficialAtlassian(server);
  const call = async (tool: string, args: Record<string, unknown>): Promise<{ ok: true; value: unknown } | Failure> => {
    try {
      // Before every call, whatever built it: the allowlist, the denylist,
      // and the server's own read-only mark.
      assertJiraToolCallable(tool, server.tools);
    } catch (error) {
      if (!(error instanceof JiraToolRefused)) throw error;
      // A connected official server without its Jira tools has a bad token.
      if (error.reason === "not_served" && official) return { ok: false, status: "needs_auth", error: { kind: "tool", message: `${tool} not served` }, tryNext: true };
      return { ok: false, status: "error", error: { kind: "tool", message: `unsupported Jira server (${error.reason}: ${tool})` }, tryNext: true };
    }
    const outcome = await caller.call(server, tool, args);
    if (outcome.ok) return outcome;
    const failure = classifyJiraFailure(outcome, official);
    return { ok: false, ...failure, tryNext: failure.status === "needs_auth" };
  };

  let site = known;
  if (!site) {
    const resources = await call(JIRA_TOOLS.resources, resourcesArgs());
    if (!resources.ok) return resources;
    site = parseResources(resources.value);
    if (!site) return { ok: false, status: "error", error: { kind: "parse", message: "no Jira site" }, tryNext: false };
  }
  const found = known ? {} : { site };

  if (request.query === "mine") {
    const page = await call(JIRA_TOOLS.search, searchArgs(site.id, request.param, request.pageToken));
    if (!page.ok) return { ...page, ...found };
    const parsed = parseSearch(page.value, site);
    if (!parsed) return { ok: false, status: "error", error: { kind: "parse", message: "unexpected search result" }, tryNext: false, ...found };
    return { ok: true, runtimeId: server.runtimeId, ...found, items: parsed.items, ...(parsed.nextPageToken ? { nextPageToken: parsed.nextPageToken } : {}) };
  }
  const key = request.param ?? "";
  const issue = await call(JIRA_TOOLS.issue, issueArgs(site.id, key));
  if (!issue.ok) return { ...issue, ...found };
  const detail = parseIssue(issue.value, site);
  if (!detail) return { ok: false, status: "error", error: { kind: "parse", message: "unexpected issue result" }, tryNext: false, ...found };
  return { ok: true, runtimeId: server.runtimeId, ...found, detail };
}

