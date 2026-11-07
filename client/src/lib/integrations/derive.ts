import type { IntegrationProvider, IntegrationState, McpAuthFlow, McpRuntimeId } from "@/lib/integrations/model";

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
}

export const EMPTY_PROFILE_INTEGRATIONS: ProfileIntegrations = {
  connection: "connecting",
  integrations: null,
  receivedAt: null,
  authFlows: {},
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

/** The integrations a rail shows: those with a server in at least one CLI.
 * One whose last server went away is gone from the rail too. */
export function railIntegrations(entry: ProfileIntegrations | undefined): IntegrationState[] {
  const state = integrationDataState(entry);
  if (state === "none" || state === "unsupported" || !entry?.integrations) return [];
  return entry.integrations.filter((integration) => integration.runtimes.length > 0);
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

/** The providers the "+" offers on this profile: those no CLI has a server for
 * yet. Nothing while the relay's state is unknown or it has no integrations
 * at all, so the menu never offers what it cannot do. */
export function addableProviders(entry: ProfileIntegrations | undefined): IntegrationProvider[] {
  if (integrationDataState(entry) !== "live") return [];
  const present = new Set(railIntegrations(entry).map((integration) => integration.provider));
  return ADDABLE_PROVIDERS.filter((provider) => !present.has(provider));
}
