// The integrations model, as the client receives it from the relay. A copy of
// relay/src/integrations/types.ts — the two npm projects share no package, so
// the contract is duplicated and tests/integrationsModelParity.test.ts holds
// the two copies identical below this header. Change the relay's copy first,
// additively: an older client reads what a newer relay sends.
//
// Pure: types and constants only.

export type IntegrationProvider = "jira" | "linear";

/** The agent CLIs whose MCP servers the relay looks at. */
export type McpRuntimeId = "claude" | "codex";

/** Where a server is declared, in the CLI's own terms: Claude's
 * `user`/`local`/`project`/`plugin`/`claudeai` (a claude.ai connector),
 * Codex's `user`/`project`, plus `managed` (policy) and `override` (a
 * per-process `-c`). */
export type McpScope = "user" | "local" | "project" | "plugin" | "claudeai" | "managed" | "override";

/** A server's state as its CLI reports it, normalized. `pending` is a
 * server the CLI has not finished starting; it is never treated as a
 * verdict. */
export type McpServerStatus = "connected" | "needs_auth" | "failed" | "pending" | "unknown";

/** How a server signs in: an OAuth flow the CLI runs, the claude.ai
 * connector flow (authorized on claude.ai, not locally), or not at all. */
export type McpAuthMode = "oauth" | "claudeai" | "none";

/** How the CLI reaches a server. `envKeys` names the variables a stdio
 * server is given, never their values. */
export interface McpTransport {
  type: "stdio" | "http" | "sse" | "claudeai-proxy";
  url?: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
}

export interface McpToolInfo {
  name: string;
  /** The tool's own `annotations.readOnlyHint`; absent when it says nothing. */
  readOnly?: boolean;
}

/** One MCP server one CLI of this profile knows about. */
export interface McpInventoryEntry {
  runtimeId: McpRuntimeId;
  name: string;
  scope: McpScope;
  /** The project folder, for a `local`/`project` server only. */
  cwd?: string;
  transport: McpTransport;
  status: McpServerStatus;
  authMode: McpAuthMode;
  /** The server's own `serverInfo.name`, when it told. */
  serverInfoName?: string;
  tools?: McpToolInfo[];
  /** Claude's own config for the server, as its status reported it, kept to
   * start a process that loads only this server. Holds no secret. */
  claudeConfig?: unknown;
  /** Epoch ms. */
  scannedAt: number;
}

/** One CLI's server for an integration, as the client shows it. */
export interface IntegrationRuntime {
  runtimeId: McpRuntimeId;
  serverName: string;
  scope: McpScope;
  cwd?: string;
  status: "connected" | "needs_auth" | "failed" | "unknown";
  authMode: McpAuthMode;
  /** Other servers of the same CLI that also match the integration and were
   * not picked. */
  alternatives: number;
}

/** The tracker instance an integration reads from (a Jira cloud site, a
 * Linear workspace). `id` is what a `TicketRef.site` holds. */
export interface IntegrationSite {
  id: string;
  url: string;
  name: string;
}

/** Remembered per profile, so every device sees the same choice. */
export interface IntegrationPrefs {
  /** The project the list is narrowed to; `null` for every project. */
  project: string | null;
}

/** Where a ticket stands, in the three buckets every tracker maps onto. */
export type TicketStatusCategory = "todo" | "doing" | "done";

/** One ticket as a list shows it. */
export interface TicketRow {
  key: string;
  id: string;
  title: string;
  statusCategory: TicketStatusCategory;
  /** The tracker's own name for the status. */
  statusLabel: string;
  priority?: string;
  /** The project's key. */
  project: string;
  /** Epoch ms. */
  updatedAt: number;
  url: string;
}

export interface TicketComment {
  author: string;
  /** Epoch ms. */
  createdAt: number;
  bodyMd: string;
}

/** One ticket as its own screen shows it. Description and comments are
 * already cut to a size worth sending. */
export interface TicketDetail extends TicketRow {
  descriptionMd?: string;
  comments: TicketComment[];
}

/** What an integration can be asked to read: the tickets assigned to the
 * signed-in person (`param` = a project key, or `null` for every project),
 * or one ticket (`param` = its key). */
export type IntegrationQueryKind = "mine" | "ticket";

/** What started the latest read: a person asking (↻), a panel opening, or
 * the agent's own call to the tracker during a turn. */
export type IntegrationReadSource = "manual" | "open" | "turn";

export type IntegrationQueryStatus = "ok" | "needs_auth" | "error" | "unknown";

export interface IntegrationQueryError {
  kind: "network" | "tool" | "parse";
  /** For a log or a tooltip; never the tracker's content. */
  message?: string;
}

interface QueryStateBase {
  status: IntegrationQueryStatus;
  /** Present on a failed read; the data of the last good one stays. */
  error?: IntegrationQueryError;
  source?: IntegrationReadSource;
  /** Epoch ms of the data shown. Absent before any read succeeded. */
  observedAt?: number;
  /** A read is in flight. */
  reading: boolean;
  readingSince?: number;
  /** A forced refresh before this (epoch ms) is refused. */
  refreshableAt?: number;
}

/** One query's cached result and read state. */
export type QueryState =
  | (QueryStateBase & {
      query: "mine";
      param: string | null;
      items?: TicketRow[];
      /** Where the next page starts; absent on the last one. */
      nextPageToken?: string;
    })
  | (QueryStateBase & { query: "ticket"; param: string; detail?: TicketDetail });

/** An integration as the client shows it. */
export interface IntegrationState {
  /** Stable id of the integration within the profile (`"jira"`). */
  id: string;
  provider: IntegrationProvider;
  /** Every CLI that has a server for it, connected or not. */
  runtimes: IntegrationRuntime[];
  /** The CLI reads go through; absent while none is connected. */
  fetchRuntime?: McpRuntimeId;
  site?: IntegrationSite;
  prefs: IntegrationPrefs;
  queries: QueryState[];
}

/** Names a ticket wherever it is passed around. `site` is the
 * `IntegrationSite.id` it lives in. */
export interface TicketRef {
  provider: IntegrationProvider;
  site: string;
  key: string;
  id?: string;
}

/** The least a list needs to show a ticket: which tracker, which key. */
export interface TicketTag {
  provider: IntegrationProvider;
  key: string;
}

/** A ticket key as every supported tracker writes one (`ENG-123`). */
export const TICKET_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

/** How a session came to work on a ticket: started from it, attached by the
 * person, opened by the agent through the tracker's MCP server, or handed
 * over by a room's principal when delegating. */
export type WorkTicketOrigin = "start" | "manual" | "mcp" | "delegate";

/** Where a room's agent that works on a ticket sits. */
export interface WorkTicketPlace {
  roomId: string;
  roomTitle: string;
  agentTitle: string;
  /** The agent's room state (`working`, `awaiting_user`, ...). */
  agentState: string;
}

/** The ticket a session works on — at most one per session; a ticket can
 * have several sessions. */
export interface WorkTicket {
  sessionId: string;
  ticket: TicketRef;
  origin: WorkTicketOrigin;
  /** Set for a room's agent only. */
  place?: WorkTicketPlace;
  /** The tool that linked it, for an `mcp` link; never the call's content. */
  evidence?: string;
  /** Epoch ms. */
  linkedAt: number;
  title?: string;
  /** The agent has not been told yet: the person's next message carries the
   * ticket. */
  lineDue: boolean;
}

/** How a sign-in reaches its end: the browser comes back through the app's
 * `anywh://` link, the person pastes the address it ended on, or the
 * connector is authorized on claude.ai. */
export type McpAuthFlowMode = "deeplink" | "localhost" | "claudeai";

export type McpAuthFlowPhase = "queued" | "awaiting_user" | "completing" | "done" | "failed" | "cancelled";

/** One server to sign in to. */
export interface McpAuthTarget {
  runtimeId: McpRuntimeId;
  serverName: string;
}

export interface McpAuthFlow {
  flowId: string;
  runtimeId: McpRuntimeId;
  serverName: string;
  phase: McpAuthFlowPhase;
  mode: McpAuthFlowMode;
  /** Where the person signs in, once known. */
  authUrl?: string;
  /** The OAuth `state` of `authUrl`, which routes a callback back to its flow. */
  state?: string;
  error?: string;
}

/** One MCP server of a session's agent, as the chat shows it. Only servers
 * of a known integration are sent. */
export interface SessionMcpServer {
  name: string;
  status: McpServerStatus;
  integrationId?: string;
  /** The relay can run this server's sign-in. */
  canLogin: boolean;
}

/** On a session's socket: its agent's MCP servers. Current state, sent again
 * on every connection. */
export interface McpStateMessage {
  type: "mcp_state";
  runtimeId: McpRuntimeId;
  servers: SessionMcpServer[];
}

/** The integrations socket of a profile. */
export const INTEGRATIONS_WATCH_PATH = "/integrations/watch";

/** What the relay sends on the integrations socket. */
export type IntegrationsServerMessage =
  /** Every integration, on connect and on every change. */
  | { type: "integrations_state"; integrations: IntegrationState[] }
  /** Every session's work ticket, on connect. */
  | { type: "work_tickets_state"; links: WorkTicket[] }
  | { type: "work_ticket_upsert"; link: WorkTicket }
  | { type: "work_ticket_removed"; sessionId: string }
  /** The answer to a `work_ticket`, to the socket that sent it. */
  | { type: "work_ticket_result"; sessionId: string; ok: true }
  | { type: "work_ticket_result"; sessionId: string; error: "conflict" | "no_session" }
  | ({ type: "mcp_auth_flow" } & McpAuthFlow)
  | { type: "pong" };

/** What the client sends on the integrations socket. */
export type IntegrationsClientMessage =
  /** `force: false` serves the cache and reads only when there is nothing;
   * `force: true` reads again, within `refreshableAt`. */
  | { type: "integration_refresh"; id: string; query: IntegrationQueryKind; param: string | null; force: boolean }
  | { type: "integration_load_more"; id: string; query: "mine"; param: string | null }
  | { type: "integration_prefs"; id: string; prefs: IntegrationPrefs }
  | { type: "work_ticket"; sessionId: string; action: "link"; ticket: TicketRef }
  | { type: "work_ticket"; sessionId: string; action: "unlink" }
  | { type: "mcp_auth_start"; targets: McpAuthTarget[]; mode?: "deeplink" | "localhost" }
  /** `callbackUrl` is where the browser ended: the `anywh://` link or the
   * pasted address. */
  | { type: "mcp_auth_complete"; flowId: string; callbackUrl: string }
  | { type: "mcp_auth_cancel"; flowId: string }
  /** For a claude.ai connector: look again whether it is authorized. */
  | { type: "mcp_auth_recheck"; flowId: string }
  /** Declares the integration's server in each CLI, then signs in. */
  | { type: "integration_add"; id: string; provider: IntegrationProvider; runtimes: McpRuntimeId[] }
  | { type: "ping" };

/** A room's agent's work ticket, as its card shows it. */
export interface RoomAgentTicket extends TicketTag {
  title?: string;
}

/** One ticket a room works on, gathered over its agents. */
export interface RoomTicketView extends TicketTag {
  title?: string;
  /** The agents that work on it. */
  agentIds: string[];
  /** The principal was handed it and has not delegated it yet. */
  carried?: true;
}
