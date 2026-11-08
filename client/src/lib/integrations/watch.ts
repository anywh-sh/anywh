import { resolveConnection } from "@/lib/profiles/connectionResolver";
import type { Profile } from "@/lib/profiles/profiles";
import { BrokerAsleepError, BrokerRevokedError, BrokerThrottledError } from "@/lib/profiles/tailnetBroker";
import { addResultKey, EMPTY_PROFILE_INTEGRATIONS, type ProfileIntegrations } from "@/lib/integrations/derive";
import { INTEGRATIONS_WATCH_PATH, type IntegrationState, type IntegrationsClientMessage, type McpAuthFlow, type McpRuntimeId, type WorkTicket } from "@/lib/integrations/model";
import { isWorkTicket, type WorkTicketMap } from "@/lib/integrations/workTickets";
import { forgetProfileFlows, noteAuthFlow, registerIntegrationsSender } from "@/lib/integrations/oauthDeepLink";

/** Backoff, liveness and handshake timings: the plan usage watch's, for the
 * same reasons (see `planUsage/watch.ts`). */
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
export const PONG_TIMEOUT_MS = 5_000;
export const PING_INTERVAL_MS = 30_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface IntegrationsWatchOptions {
  /** Whether the first connection may bring a sleeping machine up — the
   * active tab's profile only. Reconnections never wake. */
  wake: boolean;
  onChange: (state: ProfileIntegrations) => void;
  /** The client's clock, for `receivedAt`. */
  now?: () => number;
  /** Ping on a timer while the window is visible. Off for a profile behind a
   * broker, whose machine a timer would keep awake. */
  periodicPing?: boolean;
}

/**
 * One profile's `/integrations/watch` socket: keeps the relay's last
 * `integrations_state` and its sign-in flows, sends what the UI asks, and
 * reconnects with a backoff. A clone of `PlanUsageWatch`'s connection
 * handling — an older relay takes the unknown path as a chat socket and
 * opens with `protocol_version`, which marks it `unsupported` for good; a
 * silent socket is found by `ping` → `pong` — without its refresh
 * bookkeeping, since a read here is answered by a pushed state.
 *
 * It also keeps every session's work ticket (`work_tickets_state`, then each
 * `work_ticket_upsert`/`work_ticket_removed`).
 *
 * While live it is also the way `oauthDeepLink.ts` reaches this profile, and
 * it reports every `mcp_auth_flow` there, so a sign-in callback can be routed
 * to the relay that started it.
 */
export class IntegrationsWatch {
  private state: ProfileIntegrations = EMPTY_PROFILE_INTEGRATIONS;
  private socket: WebSocket | undefined;
  private retryTimer: number | undefined;
  private pongTimer: number | undefined;
  private handshakeTimer: number | undefined;
  private pingTimer: number | undefined;
  private unregisterSender: (() => void) | undefined;
  private failures = 0;
  private stopped = false;
  private resolving = false;
  private final = false;
  private readonly now: () => number;

  constructor(
    private readonly profile: Profile,
    private readonly options: IntegrationsWatchOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get current(): ProfileIntegrations {
    return this.state;
  }

  start(): void {
    this.connect(this.options.wake);
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    this.clearLiveness();
    this.detachSender();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  /** Try again now instead of waiting out a retry; on a live socket, prove
   * it is alive. No-op while connecting and on a final state. */
  retryNow(options: { wake: boolean }): void {
    if (this.stopped || this.final || this.resolving) return;
    if (this.socket) {
      this.probe();
      return;
    }
    window.clearTimeout(this.retryTimer);
    this.connect(options.wake);
  }

  /** Sends on the live socket. False when there is none: the caller's
   * action did not reach the relay. */
  send(message: IntegrationsClientMessage): boolean {
    const socket = this.socket;
    if (this.stopped || this.state.connection !== "live" || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    this.probe();
    return true;
  }

  private probe(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.state.connection !== "live" || this.pongTimer !== undefined) return;
    socket.send(JSON.stringify({ type: "ping" }));
    this.pongTimer = window.setTimeout(() => {
      this.pongTimer = undefined;
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.clearLiveness();
      this.detachSender();
      socket.close();
      this.update({ connection: "offline" });
      this.connect(false);
    }, PONG_TIMEOUT_MS);
  }

  private clearLiveness(): void {
    window.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    window.clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
    window.clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private detachSender(): void {
    this.unregisterSender?.();
    this.unregisterSender = undefined;
  }

  private update(patch: Partial<ProfileIntegrations>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.options.onChange(this.state);
  }

  private finish(connection: "unsupported" | "revoked"): void {
    this.final = true;
    this.update({ connection });
  }

  private scheduleRetry(wake: boolean, delayMs?: number): void {
    if (this.stopped || this.final) return;
    this.failures += 1;
    const backoff = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (this.failures - 1));
    this.retryTimer = window.setTimeout(() => this.connect(wake), delayMs ?? backoff);
  }

  private connect(wake: boolean): void {
    if (this.stopped || this.final) return;
    this.resolving = true;
    resolveConnection(this.profile, { wake })
      .then(({ host, port, token }) => {
        this.resolving = false;
        if (this.stopped) return;
        const query = token ? `?token=${encodeURIComponent(token)}` : "";
        this.open(new WebSocket(`ws://${host}:${String(port)}${INTEGRATIONS_WATCH_PATH}${query}`), wake);
      })
      .catch((error: unknown) => {
        this.resolving = false;
        if (this.stopped) return;
        if (error instanceof BrokerRevokedError) {
          this.finish("revoked");
          return;
        }
        this.update({ connection: "offline" });
        const slow = error instanceof BrokerThrottledError || error instanceof BrokerAsleepError;
        this.scheduleRetry(wake, slow ? MAX_RETRY_MS : undefined);
      });
  }

  private open(ws: WebSocket, wake: boolean): void {
    this.socket = ws;
    let answered = false;
    window.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = window.setTimeout(() => {
      this.handshakeTimer = undefined;
      if (this.socket !== ws || answered) return;
      this.socket = undefined;
      this.clearLiveness();
      ws.close();
      this.update({ connection: "offline" });
      this.scheduleRetry(wake);
    }, HANDSHAKE_TIMEOUT_MS);
    ws.addEventListener("message", (event: MessageEvent) => {
      if (this.socket !== ws) return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      if (message.type === "protocol_version") {
        // An older relay treating this path as a chat socket.
        if (answered) return;
        window.clearTimeout(this.handshakeTimer);
        this.handshakeTimer = undefined;
        this.socket = undefined;
        ws.close();
        this.finish("unsupported");
        return;
      }
      // Any message from this socket is as good as a pong.
      window.clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      if (message.type === "pong") return;
      if (message.type === "work_tickets_state") {
        this.update({ workTickets: Object.fromEntries(message.links.map((link) => [link.sessionId, link])) });
        return;
      }
      if (message.type === "work_ticket_upsert") {
        this.update({ workTickets: { ...(this.state.workTickets ?? {}), [message.link.sessionId]: message.link } });
        return;
      }
      if (message.type === "work_ticket_removed") {
        const { [message.sessionId]: _removed, ...rest }: WorkTicketMap = this.state.workTickets ?? {};
        this.update({ workTickets: rest });
        return;
      }
      if (message.type === "integration_add_result") {
        const { id, runtimeId, outcome } = message;
        this.update({ addResults: { ...this.state.addResults, [addResultKey(id, runtimeId)]: { ...outcome, at: this.now() } } });
        return;
      }
      if (message.type === "mcp_auth_flow") {
        noteAuthFlow(this.profile.id, message.flow);
        this.update({ authFlows: { ...this.state.authFlows, [message.flow.flowId]: message.flow } });
        return;
      }
      // `integrations_state`.
      if (!answered) {
        answered = true;
        window.clearTimeout(this.handshakeTimer);
        this.handshakeTimer = undefined;
        this.failures = 0;
        this.startPeriodicPing();
        // The relay keeps sign-ins in memory and announces the ones it has
        // right after this first state: what an earlier socket reported is
        // replaced, not merged into, or a flow a restarted relay forgot
        // would wait forever on its card.
        forgetProfileFlows(this.profile.id);
        this.update({ connection: "live", integrations: message.integrations, receivedAt: this.now(), authFlows: {} });
      } else {
        this.update({ connection: "live", integrations: message.integrations, receivedAt: this.now() });
      }
      if (!this.unregisterSender) this.unregisterSender = registerIntegrationsSender(this.profile.id, (outgoing) => this.send(outgoing));
    });
    ws.addEventListener("close", () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.clearLiveness();
      this.detachSender();
      this.update({ connection: "offline" });
      this.scheduleRetry(answered ? false : wake);
    });
  }

  private startPeriodicPing(): void {
    if (!this.options.periodicPing || this.pingTimer !== undefined) return;
    this.pingTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") this.probe();
    }, PING_INTERVAL_MS);
  }
}

type ParsedServerMessage =
  | { type: "integrations_state"; integrations: IntegrationState[] }
  | { type: "mcp_auth_flow"; flow: McpAuthFlow }
  | { type: "integration_add_result"; id: string; runtimeId: McpRuntimeId; outcome: { ok: true; serverName?: string } | { error: string } }
  | { type: "work_tickets_state"; links: WorkTicket[] }
  | { type: "work_ticket_upsert"; link: WorkTicket }
  | { type: "work_ticket_removed"; sessionId: string }
  | { type: "pong" }
  | { type: "protocol_version" };

function isIntegration(value: unknown): value is IntegrationState {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && typeof entry.provider === "string" && Array.isArray(entry.runtimes) && Array.isArray(entry.queries);
}

/**
 * The messages this socket acts on, defensively: an integration without the
 * shape is dropped rather than drawn half-read (a work ticket too), and every
 * other message — `work_ticket_result` included: the upsert that follows a
 * link is what the UI draws — is `null`, ignored.
 */
export function parseServerMessage(raw: unknown): ParsedServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  switch (message.type) {
    case "integrations_state":
      if (!Array.isArray(message.integrations)) return null;
      return {
        type: "integrations_state",
        integrations: message.integrations.filter(isIntegration).map((integration) => ({
          ...integration,
          runtimes: integration.runtimes.filter((runtime) => typeof runtime === "object" && runtime !== null && typeof runtime.runtimeId === "string"),
          prefs: integration.prefs ?? { project: null },
        })),
      };
    case "mcp_auth_flow": {
      const { type: _type, ...flow } = message;
      if (typeof flow.flowId !== "string" || typeof flow.phase !== "string") return null;
      return { type: "mcp_auth_flow", flow: flow as unknown as McpAuthFlow };
    }
    case "integration_add_result": {
      if (typeof message.id !== "string" || (message.runtimeId !== "claude" && message.runtimeId !== "codex")) return null;
      const outcome =
        message.ok === true ? { ok: true as const, ...(typeof message.serverName === "string" ? { serverName: message.serverName } : {}) } : { error: typeof message.error === "string" ? message.error : "unknown" };
      return { type: "integration_add_result", id: message.id, runtimeId: message.runtimeId, outcome };
    }
    case "work_tickets_state":
      if (!Array.isArray(message.links)) return null;
      return { type: "work_tickets_state", links: message.links.filter(isWorkTicket) };
    case "work_ticket_upsert":
      return isWorkTicket(message.link) ? { type: "work_ticket_upsert", link: message.link } : null;
    case "work_ticket_removed":
      return typeof message.sessionId === "string" ? { type: "work_ticket_removed", sessionId: message.sessionId } : null;
    case "pong":
      return { type: "pong" };
    case "protocol_version":
      return { type: "protocol_version" };
    default:
      return null;
  }
}
