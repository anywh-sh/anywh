import type { IntegrationProvider, IntegrationState, McpAuthFlow, McpRuntimeId } from "@/lib/integrations/model";
import type { WorkTicketMap } from "@/lib/integrations/workTickets";

/**
 * What the integrations UI shows, derived from what each profile's relay last
 * said. Pure: the watch (`watch.ts`) owns the socket, the hook owns which
 * profiles are watched, the components own the layout.
 */

/**
 * Where a profile's integrations socket stands — the same states as the plan
 * usage socket's (`planUsage/derive.ts`):
 * - `connecting`: no answer yet since the watch started.
 * - `live`: connected, and the relay has sent its state.
 * - `offline`: unreachable right now, retried in the background; the last
 *   state is kept.
 * - `unsupported`: the relay predates integrations. Final.
 * - `revoked`: this device's access to the profile was revoked. Final.
 */
export type IntegrationsConnection = "connecting" | "live" | "offline" | "unsupported" | "revoked";

export interface ProfileIntegrations {
  connection: IntegrationsConnection;
  /** The relay's last `integrations_state`, kept across disconnects; `null`
   * until one arrives. */
  integrations: IntegrationState[] | null;
  /** When this client received it (client clock), epoch ms. */
  receivedAt: number | null;
  /** The relay's sign-ins as it last reported them, by `flowId`. */
  authFlows: Record<string, McpAuthFlow>;
  /** Every session's work ticket, by session id, as the relay last said;
   * `null` until it has. Kept across disconnects, like `integrations`. */
  workTickets: WorkTicketMap | null;
  /** The last `integration_add_result` per integration and agent CLI (see
   * `addResultKey`), with when it arrived (client clock). */
  addResults: Record<string, IntegrationAddOutcome>;
}

export type IntegrationAddOutcome = ({ ok: true; serverName?: string } | { error: string }) & { at: number };

export const addResultKey = (integrationId: string, runtimeId: McpRuntimeId): string => `${integrationId}\u0000${runtimeId}`;

export const EMPTY_PROFILE_INTEGRATIONS: ProfileIntegrations = {
  connection: "connecting",
  integrations: null,
  receivedAt: null,
  authFlows: {},
  workTickets: null,
  addResults: {},
};

/**
 * What a profile's integration data is worth right now:
 * - `live`: current.
 * - `stale`: the relay is unreachable and this is the last state it sent.
 * - `none`: nothing to show (never answered).
 * - `unsupported`: the relay is too old to have integrations (or this device
 *   was revoked) — nothing is shown, and nothing is an error.
 */
export type IntegrationDataState = "live" | "stale" | "none" | "unsupported";

export function integrationDataState(entry: ProfileIntegrations | undefined): IntegrationDataState {
  if (!entry) return "none";
  if (entry.connection === "unsupported" || entry.connection === "revoked") return "unsupported";
  if (entry.integrations === null) return "none";
  return entry.connection === "live" ? "live" : "stale";
}

/** The integrations a rail shows: those some CLI of the profile is connected
 * to. One every CLI has yet to sign in to, that only fails, or whose state is
 * not known is not on the rail — the "+" offers it, and adding it signs the
 * existing servers in; one whose last server went away is gone too. */
export function railIntegrations(entry: ProfileIntegrations | undefined): IntegrationState[] {
  const state = integrationDataState(entry);
  if (state === "none" || state === "unsupported" || !entry?.integrations) return [];
  return entry.integrations.filter((integration) => integration.runtimes.some((runtime) => runtime.status === "connected"));
}

/** The mark on an integration's rail button: amber when a CLI has to sign in,
 * red when a CLI's server failed and none needs a sign-in — a sign-in is
 * something the person can do, so it wins. */
export type RailBadge = "needs_auth" | "failed" | null;

export function railBadge(integration: IntegrationState): RailBadge {
  if (integration.runtimes.some((runtime) => runtime.status === "needs_auth")) return "needs_auth";
  if (integration.runtimes.some((runtime) => runtime.status === "failed")) return "failed";
  return null;
}

/** How many CLIs have to sign in to the integration. */
export function runtimesNeedingAuth(integration: IntegrationState): number {
  return integration.runtimes.filter((runtime) => runtime.status === "needs_auth").length;
}

/** The CLI reads go through: the relay's choice, or — from a relay that does
 * not say — a connected one, Codex first (its tool call is part of a stable
 * protocol). */
export function pickFetchRuntime(integration: IntegrationState): McpRuntimeId | undefined {
  if (integration.fetchRuntime) return integration.fetchRuntime;
  const connected = (runtimeId: McpRuntimeId) => integration.runtimes.some((runtime) => runtime.runtimeId === runtimeId && runtime.status === "connected");
  if (connected("codex")) return "codex";
  if (connected("claude")) return "claude";
  return undefined;
}

/** Every provider the "+" may offer to add. */
export const ADDABLE_PROVIDERS: readonly IntegrationProvider[] = ["jira"];

/** The providers the "+" offers on this profile: those not on the rail, no
 * CLI being connected to them yet. Nothing while the relay's state is
 * unknown or it has no integrations at all, so the menu never offers what it
 * cannot do. */
export function addableProviders(entry: ProfileIntegrations | undefined): IntegrationProvider[] {
  if (integrationDataState(entry) !== "live") return [];
  const present = new Set(railIntegrations(entry).map((integration) => integration.provider));
  return ADDABLE_PROVIDERS.filter((provider) => !present.has(provider));
}

/** The host of the site an integration reads from ("acme.atlassian.net"),
 * `null` until the relay knows it. */
export function siteHost(integration: IntegrationState | undefined): string | null {
  const url = integration?.site?.url;
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
