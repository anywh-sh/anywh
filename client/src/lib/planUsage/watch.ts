import { resolveConnection } from "@/lib/profiles/connectionResolver";
import type { Profile } from "@/lib/profiles/profiles";
import { BrokerAsleepError, BrokerRevokedError, BrokerThrottledError } from "@/lib/profiles/tailnetBroker";
import { EMPTY_PROFILE_USAGE, type ProfilePlanUsage } from "@/lib/planUsage/derive";
import type { PlanUsageRefreshMessage, PlanUsageRuntime, PlanWindow, RuntimePlanUsage } from "@/lib/planUsage/model";

/** First retry after a connection drops or fails; doubled per consecutive
 * failure up to `MAX_RETRY_MS`. Unlike the sidebar's watch (a flat 2s), this
 * one also runs for profiles nobody is looking at, so an unreachable machine
 * must settle into a slow pace instead of being dialed every two seconds for
 * as long as the app is open. */
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

/** How long a refresh may go unanswered before the spinner gives up. The
 * relay's slowest read (a Claude probe) is well under this; past it the
 * answer is either never coming or will arrive as an ordinary push. */
export const REFRESH_TIMEOUT_MS = 30_000;

export const PLAN_USAGE_WATCH_PATH = "/plan-usage/watch";

export interface PlanUsageWatchOptions {
  /** Whether the first connection may bring a sleeping machine up — true for
   * the active tab's profile only. Reconnections never wake (a dropped socket
   * most often means the machine went to sleep because nobody used it). */
  wake: boolean;
  onChange: (state: ProfilePlanUsage) => void;
  /** The client's clock, for `receivedAt`. */
  now?: () => number;
}

/**
 * One profile's `/plan-usage/watch` socket: connects, keeps the relay's last
 * `plan_usage_state`, reconnects with a backoff, and stops for good on a
 * relay too old to have the route or a revoked device.
 *
 * An older relay doesn't refuse the path: it has no route table for sockets,
 * so any unknown path is taken as a chat connection, which opens and starts
 * with `protocol_version`. That first message is how such a relay is
 * recognized; the socket is
 * closed right away and never redialed. A socket that fails to open at all
 * (the machine is off, or the upgrade was refused) is retried.
 */
export class PlanUsageWatch {
  private state: ProfilePlanUsage = EMPTY_PROFILE_USAGE;
  private socket: WebSocket | undefined;
  private retryTimer: number | undefined;
  private refreshTimer: number | undefined;
  private failures = 0;
  private stopped = false;
  private resolving = false;
  private final = false;
  private readonly now: () => number;

  constructor(
    private readonly profile: Profile,
    private readonly options: PlanUsageWatchOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get current(): ProfilePlanUsage {
    return this.state;
  }

  start(): void {
    this.connect(this.options.wake);
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.refreshTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  /**
   * Try again now instead of waiting out a retry: the app came back to the
   * foreground, or this profile just became the active tab's (`wake: true`,
   * the only later moment a sleeping machine may be woken). No-op while
   * connected or connecting, and on a final state.
   */
  retryNow(options: { wake: boolean }): void {
    if (this.stopped || this.final || this.resolving || this.socket) return;
    window.clearTimeout(this.retryTimer);
    this.connect(options.wake);
  }

  /** Sends `plan_usage_refresh`; false when there is no live socket to send
   * it on. The spinner state clears on the next `plan_usage_state`. */
  refresh(force: boolean, runtime?: PlanUsageRuntime): boolean {
    const socket = this.socket;
    if (this.state.connection !== "live" || socket?.readyState !== WebSocket.OPEN) return false;
    const message: PlanUsageRefreshMessage = { type: "plan_usage_refresh", force, ...(runtime ? { runtime } : {}) };
    socket.send(JSON.stringify(message));
    this.update({ refreshing: true });
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.update({ refreshing: false }), REFRESH_TIMEOUT_MS);
    return true;
  }

  private update(patch: Partial<ProfilePlanUsage>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.options.onChange(this.state);
  }

  private finish(connection: "unsupported" | "revoked"): void {
    this.final = true;
    window.clearTimeout(this.refreshTimer);
    this.update({ connection, refreshing: false });
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
        this.open(new WebSocket(`ws://${host}:${String(port)}${PLAN_USAGE_WATCH_PATH}${query}`), wake);
      })
      .catch((error: unknown) => {
        this.resolving = false;
        if (this.stopped) return;
        if (error instanceof BrokerRevokedError) {
          this.finish("revoked");
          return;
        }
        this.update({ connection: "offline", refreshing: false });
        // The broker asked to be left alone, or the machine is asleep:
        // nothing this loop does changes either, so go straight to the
        // slowest pace. A failed first attempt keeps its own intent to
        // wake — it was still the user opening the app.
        const slow = error instanceof BrokerThrottledError || error instanceof BrokerAsleepError;
        this.scheduleRetry(wake, slow ? MAX_RETRY_MS : undefined);
      });
  }

  private open(ws: WebSocket, wake: boolean): void {
    this.socket = ws;
    let answered = false;
    ws.addEventListener("message", (event: MessageEvent) => {
      if (this.socket !== ws) return;
      const message = parseStateMessage(event.data);
      if (!message) {
        // An older relay treating this path as a chat socket opens with its
        // protocol version (see the class comment). Anything else unknown is
        // ignored, so a later relay can add messages to this socket.
        if (!answered && messageType(event.data) === "protocol_version") {
          this.socket = undefined;
          ws.close();
          this.finish("unsupported");
        }
        return;
      }
      answered = true;
      this.failures = 0;
      window.clearTimeout(this.refreshTimer);
      this.update({
        connection: "live",
        runtimes: message.runtimes,
        observedAt: message.observedAt,
        receivedAt: this.now(),
        refreshing: false,
      });
    });
    ws.addEventListener("close", () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      window.clearTimeout(this.refreshTimer);
      this.update({ connection: "offline", refreshing: false });
      // A socket that was serving dropped (relay restart, machine asleep):
      // reconnect without waking. One that never answered keeps the
      // attempt's intent, like a failed resolve.
      this.scheduleRetry(answered ? false : wake);
    });
  }
}

function messageType(raw: unknown): unknown {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return typeof parsed === "object" && parsed !== null ? (parsed as { type?: unknown }).type : undefined;
  } catch {
    return undefined;
  }
}

function isWindow(value: unknown): value is PlanWindow {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.durationMins === "number" &&
    typeof entry.usedPercent === "number" &&
    (entry.resetsAt === null || typeof entry.resetsAt === "number")
  );
}

function isRuntimeUsage(value: unknown): value is RuntimePlanUsage {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.runtime === "string" && typeof entry.status === "string" && Array.isArray(entry.windows);
}

/** A `plan_usage_state`, defensively: a runtime entry or window that doesn't
 * have the shape is dropped rather than rendered half-read. */
export function parseStateMessage(raw: unknown): { runtimes: RuntimePlanUsage[]; observedAt: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { type, runtimes, observedAt } = parsed as { type?: unknown; runtimes?: unknown; observedAt?: unknown };
  if (type !== "plan_usage_state" || !Array.isArray(runtimes)) return null;
  return {
    runtimes: runtimes.filter(isRuntimeUsage).map((entry) => ({
      ...entry,
      windows: (entry.windows as unknown[]).filter(isWindow),
      observedAt: typeof entry.observedAt === "number" ? entry.observedAt : null,
    })),
    observedAt: typeof observedAt === "number" ? observedAt : Date.now(),
  };
}
