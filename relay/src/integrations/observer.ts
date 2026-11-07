// Watches the agent's own calls to a tracker's MCP server, in every
// session's turn stream: a ticket the agent read or changed refreshes the
// cache (no read of the relay's own), and the first ticket an agent opens in
// a session that has none becomes that session's ticket. It only watches —
// the agent's calls go through untouched and the agent may read as many
// tickets as it likes; only the link is limited to one.
//
// A server counts when the inventory knows it for what it is (where it
// points, what it serves), never by name, and never one of the relay's own
// bridges (`anywh-*`). Only calls that succeeded count. Errors are
// swallowed: a turn never fails because of this.
//
// Synchronous and side-effect free but for the two sinks it is given.
import type { AgentEvent } from "../protocol/agent-event.js";
import { observeJiraCall } from "./providers/jira.js";
import { observedToolValue } from "./toolResult.js";
import type { TicketLinks } from "./ticketLinks.js";
import type { IntegrationProvider, IntegrationSite, TicketDetail, TicketRef, TicketRow } from "./types.js";

/** Calls awaiting their result, across sessions; the oldest go past this. */
const MAX_PENDING_CALLS = 256;
const RELAY_BRIDGE_PREFIX = "anywh-";

export interface TicketObserverDeps {
  /** The integration a server of a turn belongs to (see
   * `IntegrationService.identifyServer`). */
  readonly identify: (runtimeId: string, server: string) => { integrationId: string; provider: IntegrationProvider; site?: IntegrationSite } | undefined;
  /** See `IntegrationService.observeTickets`. */
  readonly ingest: (integrationId: string, observed: { detail?: TicketDetail; rows?: readonly TicketRow[] }) => void;
  readonly links: Pick<TicketLinks, "get" | "link">;
  /** Whether the agent of a session may be given a ticket by opening one
   * (a room's principal may not). Every session may when absent. */
  readonly mayLink?: (sessionId: string) => boolean;
}

interface PendingCall {
  readonly integrationId: string;
  readonly provider: IntegrationProvider;
  readonly site?: IntegrationSite;
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export class TicketObserver {
  private readonly pending = new Map<string, PendingCall>();

  constructor(private readonly deps: TicketObserverDeps) {}

  /** One event of a turn of `sessionId`, whose agent is `runtimeId`. */
  observe(sessionId: string, runtimeId: string, event: AgentEvent): void {
    try {
      if (event.type === "tool_started") this.started(sessionId, runtimeId, event);
      else if (event.type === "tool_ended") this.ended(sessionId, event);
    } catch (error) {
      console.error("[relay] ticket observer failed:", (error as Error).message);
    }
  }

  private started(sessionId: string, runtimeId: string, event: Extract<AgentEvent, { type: "tool_started" }>): void {
    if (event.toolUseId === undefined || event.subject?.kind !== "mcp") return;
    const { server, tool } = event.subject;
    if (server.startsWith(RELAY_BRIDGE_PREFIX)) return;
    const integration = this.deps.identify(runtimeId, server);
    if (!integration) return;
    this.pending.set(callKey(sessionId, event.toolUseId), { ...integration, tool, input: event.input });
    if (this.pending.size > MAX_PENDING_CALLS) this.pending.delete(this.pending.keys().next().value as string);
  }

  private ended(sessionId: string, event: Extract<AgentEvent, { type: "tool_ended" }>): void {
    if (event.toolUseId === undefined) return;
    const key = callKey(sessionId, event.toolUseId);
    const call = this.pending.get(key);
    if (!call) return;
    this.pending.delete(key);
    if (event.isError) return;
    const value = observedToolValue(event.content);
    if (value === undefined) return;
    const site = call.site ?? siteFromInput(call.input);
    // Only Jira has an adapter today.
    if (call.provider !== "jira") return;
    const observed = observeJiraCall(call.tool, call.input, value, site);
    if (!observed) return;
    if (observed.detail || observed.rows) this.deps.ingest(call.integrationId, { ...(observed.detail ? { detail: observed.detail } : {}), ...(observed.rows ? { rows: observed.rows } : {}) });
    if (!observed.key || site.id === "" || this.deps.mayLink?.(sessionId) === false || this.deps.links.get(sessionId)) return;
    const ticket: TicketRef = { provider: call.provider, site: site.id, key: observed.key, ...(observed.detail?.id ? { id: observed.detail.id } : {}) };
    this.deps.links.link(sessionId, ticket, "mcp", { evidence: call.tool, ...(observed.detail?.title ? { title: observed.detail.title } : {}) });
  }
}

const callKey = (sessionId: string, toolUseId: string): string => `${sessionId}\u0000${toolUseId}`;

/** The site a call went to, by the `cloudId` the agent passed (an id, or the
 * site's address), for a profile whose site the relay never read itself. */
function siteFromInput(input: Record<string, unknown>): IntegrationSite {
  const cloudId = typeof input.cloudId === "string" ? input.cloudId.trim() : "";
  const url = /^https?:\/\//i.test(cloudId) ? cloudId.replace(/\/+$/, "") : "";
  return { id: cloudId, url, name: cloudId };
}
