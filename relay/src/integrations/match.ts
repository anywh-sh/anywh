// Which of a profile's MCP servers an integration runs through. A server is
// recognized by what it is (where it points, what it calls itself, which
// package it runs, which tools it serves) before what it is named; then one
// server per CLI is picked and the others are kept as alternatives.
//
// Pure.
import type { IntegrationProvider, IntegrationRuntime, McpInventoryEntry, McpRuntimeId, McpScope } from "./types.js";

/** How a server was recognized, strongest first. `name` alone is a
 * candidate only: it never wins over a server recognized otherwise. */
export type MatchTier = "host" | "serverInfo" | "package" | "tools" | "name";

export type IntegrationRuntimeStatus = IntegrationRuntime["status"];

/** One provider's recognition rules. */
export interface IntegrationRecognizer {
  readonly provider: IntegrationProvider;
  /** `undefined`: not a server of this provider. */
  readonly recognize: (entry: McpInventoryEntry) => MatchTier | undefined;
  /** The server's state for this integration, which can be stricter than
   * what the CLI says (a server that answers but serves none of the
   * provider's tools is not signed in). */
  readonly status: (entry: McpInventoryEntry) => IntegrationRuntimeStatus;
}

/** The server picked for one CLI, and the other matching ones. */
export interface IntegrationPick {
  readonly runtimeId: McpRuntimeId;
  readonly tier: MatchTier;
  readonly chosen: McpInventoryEntry;
  readonly status: IntegrationRuntimeStatus;
  /** Best first. */
  readonly alternatives: readonly McpInventoryEntry[];
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

const isAtlassianHost = (host: string): boolean => host === "mcp.atlassian.com" || host === "atlassian.net" || host.endsWith(".atlassian.net");

/** The official remote server (Jira, Confluence and Compass in one): its
 * host, wherever it shows up (a URL, or an argument of a stdio bridge such
 * as `mcp-remote`). */
function pointsAtAtlassian(entry: McpInventoryEntry): boolean {
  const candidates = [entry.transport.url, ...(entry.transport.args ?? [])];
  return candidates.some((value) => {
    if (!value || !/^https?:\/\//i.test(value)) return false;
    const host = hostOf(value);
    return host !== undefined && isAtlassianHost(host);
  });
}

/** Community Jira servers, by package or image name (version or tag cut
 * off before comparing). */
const JIRA_PACKAGES = new Set(["mcp-atlassian", "ghcr.io/sooperset/mcp-atlassian", "@aashari/mcp-server-atlassian-jira", "jira-mcp", "mcp-jira", "@atlassian/mcp-atlassian"]);
const JIRA_TOKEN = /(^|[/@_-])(jira|atlassian)([/@_.-]|$)/i;
const JIRA_ENV = /^(JIRA|ATLASSIAN)_/i;
const JIRA_TOOL = /jira/i;

function packageName(token: string): string {
  // `pkg@1.2.3`, `@scope/pkg@latest`, `image:tag`.
  const withoutTag = token.replace(/:[^/]*$/, "");
  const at = withoutTag.lastIndexOf("@");
  return (at > 0 ? withoutTag.slice(0, at) : withoutTag).toLowerCase();
}

function runsJiraPackage(entry: McpInventoryEntry): boolean {
  if (entry.transport.type !== "stdio") return false;
  const tokens = [entry.transport.command ?? "", ...(entry.transport.args ?? [])].filter((token) => token !== "" && !token.startsWith("-"));
  if (tokens.some((token) => JIRA_PACKAGES.has(packageName(token)))) return true;
  if (tokens.some((token) => JIRA_TOKEN.test(token.split("/").pop() ?? token))) return true;
  return (entry.transport.envKeys ?? []).some((key) => JIRA_ENV.test(key));
}

/** Atlassian runs other products' servers too (Trello's, at
 * `mcp.trello.com`), and they call themselves `atlassian-mcp-server` as
 * well. So that name counts as Jira only when the server is not one of
 * those: one whose URL is another host and whose catalog has tools but no
 * Jira one. A proxy in front of Atlassian's server (another host, Jira's
 * tools) still counts. */
function anotherAtlassianProduct(entry: McpInventoryEntry): boolean {
  const host = entry.transport.url ? hostOf(entry.transport.url) : undefined;
  if (host === undefined || isAtlassianHost(host)) return false;
  if (host === "trello.com" || host.endsWith(".trello.com")) return true;
  return (entry.tools?.length ?? 0) > 0 && !servesJiraTools(entry);
}

/** Atlassian's own remote server (by where it points or what it calls
 * itself), as opposed to a community Jira server. */
export const isOfficialAtlassian = (entry: McpInventoryEntry): boolean =>
  pointsAtAtlassian(entry) || (entry.serverInfoName === "atlassian-mcp-server" && !anotherAtlassianProduct(entry));
const servesJiraTools = (entry: McpInventoryEntry): boolean => (entry.tools ?? []).some((tool) => JIRA_TOOL.test(tool.name));

function recognizeJira(entry: McpInventoryEntry): MatchTier | undefined {
  const official = isOfficialAtlassian(entry);
  // A catalog with no Jira tool is not Jira — except the official server's,
  // which serves a reduced catalog when its token is bad (see `jiraStatus`).
  if (!official && entry.tools && entry.tools.length > 0 && !servesJiraTools(entry)) return undefined;
  if (pointsAtAtlassian(entry)) return "host";
  if (official) return "serverInfo";
  if (runsJiraPackage(entry)) return "package";
  if (servesJiraTools(entry)) return "tools";
  if (/jira|atlassian/i.test(entry.name)) return "name";
  return undefined;
}

function jiraStatus(entry: McpInventoryEntry): IntegrationRuntimeStatus {
  switch (entry.status) {
    case "connected":
      // Seen with a bad token: the handshake succeeds and the catalog has a
      // handful of tools, none of them Jira's. Only a sign-in fixes that.
      if (isOfficialAtlassian(entry) && entry.tools && !servesJiraTools(entry)) return "needs_auth";
      return "connected";
    case "needs_auth":
    case "failed":
      return entry.status;
    case "pending":
    case "unknown":
      return "unknown";
  }
}

export const JIRA_RECOGNIZER: IntegrationRecognizer = { provider: "jira", recognize: recognizeJira, status: jiraStatus };

const STATUS_RANK: Record<IntegrationRuntimeStatus, number> = { connected: 0, needs_auth: 1, failed: 2, unknown: 2 };
// An account-wide or user-wide server is the one every session has; a
// project's own copy only exists inside that project.
const SCOPE_RANK: Record<McpScope, number> = { claudeai: 0, user: 0, managed: 0, plugin: 1, override: 1, local: 2, project: 2 };

interface Candidate {
  readonly entry: McpInventoryEntry;
  readonly tier: MatchTier;
  readonly status: IntegrationRuntimeStatus;
}

function compare(a: Candidate, b: Candidate): number {
  return (
    Number(a.tier === "name") - Number(b.tier === "name") ||
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    SCOPE_RANK[a.entry.scope] - SCOPE_RANK[b.entry.scope] ||
    a.entry.name.localeCompare(b.entry.name) ||
    (a.entry.cwd ?? "").localeCompare(b.entry.cwd ?? "")
  );
}

/** One server per CLI for `recognizer`'s provider: recognized otherwise
 * than by name first, then connected, then needing a sign-in; then
 * account/user-wide over a plugin's over a project's. Every other match is
 * an alternative. CLIs with no match are absent. */
export function pickIntegration(entries: readonly McpInventoryEntry[], recognizer: IntegrationRecognizer): IntegrationPick[] {
  const byRuntime = new Map<McpRuntimeId, Candidate[]>();
  for (const entry of entries) {
    const tier = recognizer.recognize(entry);
    if (!tier) continue;
    const list = byRuntime.get(entry.runtimeId) ?? [];
    list.push({ entry, tier, status: recognizer.status(entry) });
    byRuntime.set(entry.runtimeId, list);
  }
  const picks: IntegrationPick[] = [];
  for (const [runtimeId, candidates] of byRuntime) {
    const [best, ...rest] = candidates.sort(compare);
    picks.push({ runtimeId, tier: best.tier, chosen: best.entry, status: best.status, alternatives: rest.map((candidate) => candidate.entry) });
  }
  return picks.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
}

/** The picks as the client sees them. */
export function integrationRuntimes(picks: readonly IntegrationPick[]): IntegrationRuntime[] {
  return picks.map((pick) => ({
    runtimeId: pick.runtimeId,
    serverName: pick.chosen.name,
    scope: pick.chosen.scope,
    ...(pick.chosen.cwd !== undefined ? { cwd: pick.chosen.cwd } : {}),
    status: pick.status,
    authMode: pick.chosen.authMode,
    alternatives: pick.alternatives.length,
  }));
}
