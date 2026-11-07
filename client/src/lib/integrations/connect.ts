import type { IntegrationRuntime, IntegrationState, McpAuthFlow, McpAuthTarget, McpRuntimeId } from "@/lib/integrations/model";

/**
 * What the connect card shows for each agent of a profile, derived from the
 * relay's integration state and its sign-in flows. Pure: the card owns the
 * layout and the socket.
 */

/** Every CLI an integration can live in, in the order the card lists them. */
export const CONNECT_RUNTIMES: readonly McpRuntimeId[] = ["claude", "codex"];

/**
 * One agent's line on the card:
 * - `connected`: its server answers.
 * - `needs_auth`: it has the server and has to sign in.
 * - `failed`/`unknown`: it has the server, which is not usable for another
 *   reason (nothing to sign in to).
 * - `missing`: the agent is installed but has no server for the integration.
 */
export type ConnectRowState = "connected" | "needs_auth" | "failed" | "unknown" | "missing";

export interface ConnectRow {
  runtimeId: McpRuntimeId;
  state: ConnectRowState;
  /** The agent's server, absent for `missing`. */
  runtime?: IntegrationRuntime;
  /** The latest sign-in of this server that is still worth showing: one
   * under way, or one that failed (until it is tried again). A cancelled
   * one is gone; a finished one shows as `connected`. */
  flow?: McpAuthFlow;
}

const ACTIVE_PHASES = new Set<McpAuthFlow["phase"]>(["queued", "awaiting_user", "completing"]);

export function isActiveFlow(flow: McpAuthFlow): boolean {
  return ACTIVE_PHASES.has(flow.phase);
}

/** The newest flow of one server. Flows are kept by id in arrival order, so
 * the last match is the newest. */
function latestFlow(flows: Record<string, McpAuthFlow>, runtimeId: McpRuntimeId, serverName: string | undefined): McpAuthFlow | undefined {
  let latest: McpAuthFlow | undefined;
  for (const flow of Object.values(flows)) {
    if (flow.runtimeId !== runtimeId) continue;
    if (serverName !== undefined && flow.serverName !== serverName) continue;
    latest = flow;
  }
  return latest;
}

/**
 * The card's lines: every agent that has a server for the integration, then
 * every installed agent that has none (`installed`; `null` when the machine
 * could not say, which lists only the agents with a server).
 */
export function connectRows(integration: IntegrationState | undefined, flows: Record<string, McpAuthFlow>, installed: readonly McpRuntimeId[] | null): ConnectRow[] {
  const rows: ConnectRow[] = [];
  for (const runtimeId of CONNECT_RUNTIMES) {
    const runtime = integration?.runtimes.find((entry) => entry.runtimeId === runtimeId);
    if (!runtime) {
      if (installed?.includes(runtimeId)) rows.push({ runtimeId, state: "missing" });
      continue;
    }
    const flow = latestFlow(flows, runtimeId, runtime.serverName);
    const done = flow?.phase === "done";
    const state: ConnectRowState = done ? "connected" : runtime.status;
    const shown = flow && (isActiveFlow(flow) || flow.phase === "failed") ? flow : undefined;
    rows.push({ runtimeId, state, runtime, ...(shown ? { flow: shown } : {}) });
  }
  return rows;
}

/** "1 of 2": agents connected, out of the agents listed. */
export function connectProgress(rows: readonly ConnectRow[]): { connected: number; total: number } {
  return { connected: rows.filter((row) => row.state === "connected").length, total: rows.length };
}

/** The servers a "Connect all" signs in to, in order: every line that has to
 * sign in and is not already doing so. */
export function pendingTargets(rows: readonly ConnectRow[]): McpAuthTarget[] {
  return rows
    .filter((row) => row.state === "needs_auth" && row.runtime && !(row.flow && isActiveFlow(row.flow)))
    .map((row) => ({ runtimeId: row.runtimeId, serverName: row.runtime!.serverName }));
}

/** Why a pasted address cannot finish a sign-in. */
export type CallbackPasteError = "not_url" | "missing_code" | "state_mismatch";

/** The reasons a sign-in reports (`McpAuthFlow.error`) the card has words
 * for: the relay's own codes, the provider's refusal, and a callback the
 * relay turned down. Anything else — a CLI's own text — is `generic`. */
export type FlowErrorKey = CallbackPasteError | "timeout" | "unknown_server" | "unsupported" | "access_denied" | "not_authorized" | "unknown_flow" | "not_waiting" | "generic";

const FLOW_ERROR_KEYS: ReadonlySet<string> = new Set<FlowErrorKey>(["not_url", "missing_code", "state_mismatch", "timeout", "unknown_server", "unsupported", "access_denied", "not_authorized", "unknown_flow", "not_waiting"]);

/** Which of the card's messages a flow's `error` reads as. Pure. */
export function flowErrorKey(error: string): FlowErrorKey {
  const code = error.trim();
  return FLOW_ERROR_KEYS.has(code) ? (code as FlowErrorKey) : "generic";
}

/**
 * Checks the address the browser ended on before it is sent: a URL that
 * carries the authorization `code` (or the server's `error`) and the
 * flow's own `state`. A wrong paste is caught here rather than by a
 * failed sign-in the relay would have to report.
 */
export function checkCallbackPaste(text: string, flow: Pick<McpAuthFlow, "state">): { ok: true; url: string } | { ok: false; error: CallbackPasteError } {
  const trimmed = text.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "not_url" };
  }
  const params = url.searchParams;
  if (!params.get("code") && !params.get("error")) return { ok: false, error: "missing_code" };
  const state = params.get("state");
  if (!state || (flow.state !== undefined && state !== flow.state)) return { ok: false, error: "state_mismatch" };
  return { ok: true, url: trimmed };
}

/** The integration a session's MCP server belongs to: the one whose server
 * for the session's agent has that name. */
export function integrationForServer(integrations: readonly IntegrationState[] | null, runtimeId: string | null, serverName: string): IntegrationState | undefined {
  return integrations?.find((integration) =>
    integration.runtimes.some((runtime) => runtime.serverName === serverName && (runtimeId === null || runtime.runtimeId === runtimeId)),
  );
}
