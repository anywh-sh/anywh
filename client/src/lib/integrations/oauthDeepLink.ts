import type { IntegrationsClientMessage, McpAuthFlow } from "@/lib/integrations/model";

/**
 * Routes an MCP sign-in's `anywh://mcp-oauth/callback…` link back to the
 * relay that started it.
 *
 * The browser ends an OAuth sign-in on the app's own scheme, and the OS hands
 * that link to the app — not to a profile. Which relay is waiting for it is
 * read from the link's OAuth `state`: every relay announces its pending
 * flows (`mcp_auth_flow`, with the `state` of their `authUrl`) on its
 * integrations socket, and that socket registers itself here as the way to
 * reach its profile. A link is forwarded as `mcp_auth_complete` on the
 * socket of the profile whose flow carries its `state`, and nowhere else.
 *
 * A link can arrive before what it needs: on a cold launch (the app was
 * closed while the person signed in) no socket has connected yet, and a
 * socket that dropped is redialing. So a link that cannot be delivered right
 * away waits a little for the flow or the socket to show up; past that it is
 * dropped with a notice. A `state` no relay ever announced is someone else's
 * link (another install of the app, a sign-in that already ended) and is
 * never sent anywhere.
 *
 * Module state rather than React state: the deep link listener lives above
 * the shell (`App`), the sockets inside it, and neither should re-render for
 * the other.
 */

/** The link's host — what tells it apart from `anywh://import-profile`. */
export const MCP_OAUTH_HOST = "mcp-oauth";

/** How long a link waits for its flow or its relay's socket. Long enough for
 * a cold launch to connect, short enough that the notice still reads as the
 * answer to the click that opened the link. */
export const CALLBACK_GRACE_MS = 15_000;

export interface McpOAuthCallback {
  /** The whole link, as the relay gets it: it holds the code (or the error)
   * and, for Codex, the path its local callback server expects. */
  url: string;
  state: string;
}

/** Whether `url` is an `anywh://mcp-oauth/…` link at all, well formed or not. */
export function isMcpOAuthLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    // A custom scheme has no real authority, but the parser still puts what
    // follows `://` in `hostname` (the same reading `profileImport.ts` uses).
    return parsed.protocol === "anywh:" && parsed.hostname === MCP_OAUTH_HOST;
  } catch {
    return false;
  }
}

/**
 * `anywh://mcp-oauth/callback?code=…&state=…` (Claude) or
 * `anywh://mcp-oauth/callback/<id>?code=…&state=…` (Codex), or `null`. A
 * provider's refusal (`?error=…&state=…`) is a callback too: the relay ends
 * the flow with it. Pure.
 */
export function parseMcpOAuthCallback(url: string): McpOAuthCallback | null {
  if (!isMcpOAuthLink(url)) return null;
  const parsed = new URL(url);
  if (parsed.pathname !== "/callback" && !parsed.pathname.startsWith("/callback/")) return null;
  const state = parsed.searchParams.get("state");
  if (!state) return null;
  return { url, state };
}

/** Sends on a profile's integrations socket; false when it is not open. */
export type IntegrationsSender = (message: IntegrationsClientMessage) => boolean;

/** Why a link was given up on, for the notice. */
export type McpOAuthNoticeKind = "unknown" | "unreachable";

export interface McpOAuthNotice {
  id: number;
  kind: McpOAuthNoticeKind;
}

interface PendingFlow {
  profileId: string;
  flowId: string;
}

interface HeldCallback {
  callback: McpOAuthCallback;
  timer: ReturnType<typeof setTimeout>;
}

const TERMINAL_PHASES = new Set<McpAuthFlow["phase"]>(["done", "failed", "cancelled"]);

/** How long a link already forwarded is recognized as a repeat: the cold
 * launch and the running app can both report one, a little apart. */
export const DELIVERED_TTL_MS = 60_000;

const flowsByState = new Map<string, PendingFlow>();
const senders = new Map<string, IntegrationsSender>();
const held: HeldCallback[] = [];
/** Links forwarded, by the whole link, with the profile they went to and
 * when they stop counting as repeats. The same `state` with another code (a
 * retry) is not a repeat. */
const delivered = new Map<string, { profileId: string; until: number }>();
let notice: McpOAuthNotice | null = null;
let noticeSeq = 0;
const noticeListeners = new Set<() => void>();

function setNotice(next: McpOAuthNotice | null): void {
  notice = next;
  for (const listener of noticeListeners) listener();
}

/** Delivers `callback` if its flow and its socket are both known. */
function tryDeliver(callback: McpOAuthCallback): boolean {
  const flow = flowsByState.get(callback.state);
  if (!flow) return false;
  const send = senders.get(flow.profileId);
  if (!send?.({ type: "mcp_auth_complete", flowId: flow.flowId, callbackUrl: callback.url })) return false;
  // One callback ends a flow: a second copy of the same link (the cold
  // launch and the running app can both report it) has nowhere to go.
  flowsByState.delete(callback.state);
  delivered.set(callback.url, { profileId: flow.profileId, until: Date.now() + DELIVERED_TTL_MS });
  return true;
}

function retryHeld(): void {
  for (const entry of [...held]) {
    if (!tryDeliver(entry.callback)) continue;
    clearTimeout(entry.timer);
    held.splice(held.indexOf(entry), 1);
  }
}

/**
 * Takes one link the OS delivered. Not an MCP sign-in link: `false`, left to
 * the other listeners. Otherwise `true`, whether it was forwarded now, is
 * waiting, or was a repeat.
 */
export function routeMcpOAuthCallback(url: string): boolean {
  if (!isMcpOAuthLink(url)) return false;
  const callback = parseMcpOAuthCallback(url);
  if (!callback) {
    setNotice({ id: ++noticeSeq, kind: "unknown" });
    return true;
  }
  if (held.some((entry) => entry.callback.url === url)) return true;
  // A repeat of a link already forwarded: neither sent again (the relay
  // would refuse it) nor held into a false "nobody was waiting".
  const now = Date.now();
  for (const [link, { until }] of delivered) if (until <= now) delivered.delete(link);
  if (delivered.has(url)) return true;
  if (tryDeliver(callback)) return true;
  const entry: HeldCallback = {
    callback,
    timer: setTimeout(() => {
      const index = held.indexOf(entry);
      if (index === -1) return;
      held.splice(index, 1);
      // A flow that is known but whose relay never answered is not the
      // same failure as a link nobody was waiting for.
      setNotice({ id: ++noticeSeq, kind: flowsByState.has(callback.state) ? "unreachable" : "unknown" });
    }, CALLBACK_GRACE_MS),
  };
  held.push(entry);
  return true;
}

/** A relay's report of one of its sign-ins. Its `state` routes callbacks to
 * it from now on; an ended flow stops being a destination. */
export function noteAuthFlow(profileId: string, flow: McpAuthFlow): void {
  if (TERMINAL_PHASES.has(flow.phase)) {
    for (const [state, pending] of flowsByState) {
      if (pending.profileId === profileId && pending.flowId === flow.flowId) flowsByState.delete(state);
    }
    return;
  }
  // A claude.ai connector is authorized on claude.ai and never comes back
  // through the app.
  if (!flow.state || flow.mode === "claudeai") return;
  flowsByState.set(flow.state, { profileId, flowId: flow.flowId });
  retryHeld();
}

/** A profile's relay (re)connected: it announces the flows it still has
 * right after, so every state it announced before stops routing until it
 * does again — a relay that restarted mid sign-in forgot its flow, and a
 * link for it is someone else's link now. A link sent to it before may
 * have died with the old socket: a repeat of it is sent again. */
export function forgetProfileFlows(profileId: string): void {
  for (const [state, pending] of flowsByState) {
    if (pending.profileId === profileId) flowsByState.delete(state);
  }
  for (const [link, sent] of delivered) {
    if (sent.profileId === profileId) delivered.delete(link);
  }
}

/** A profile's integrations socket is open: links for its flows go to
 * `send`. Returns the unregistration, which only removes this same sender. */
export function registerIntegrationsSender(profileId: string, send: IntegrationsSender): () => void {
  senders.set(profileId, send);
  retryHeld();
  return () => {
    if (senders.get(profileId) === send) senders.delete(profileId);
  };
}

/** The last link given up on, until dismissed. */
export function getMcpOAuthNotice(): McpOAuthNotice | null {
  return notice;
}

export function subscribeMcpOAuthNotice(listener: () => void): () => void {
  noticeListeners.add(listener);
  return () => noticeListeners.delete(listener);
}

export function dismissMcpOAuthNotice(): void {
  setNotice(null);
}

export function __resetMcpOAuthForTests(): void {
  for (const entry of held) clearTimeout(entry.timer);
  held.length = 0;
  flowsByState.clear();
  senders.clear();
  delivered.clear();
  notice = null;
}
