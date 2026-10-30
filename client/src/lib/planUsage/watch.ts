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

/** How long a `ping` waits for its `pong` before the socket is written off.
 * A live relay answers in one round-trip; this only has to outlast a slow
 * tunnel's, since being wrong costs one reconnect. Same as the sidebar's. */
export const PONG_TIMEOUT_MS = 5_000;

/** The liveness ping's pace while the window is visible, on a profile that
 * may be pinged on a timer (see `periodicPing`). */
export const PING_INTERVAL_MS = 30_000;

/** A refresh lost to a dead socket is sent again on the next connection,
 * this many times at most. */
const REFRESH_RESENDS = 2;

export interface PlanUsageWatchOptions {
  /** Whether the first connection may bring a sleeping machine up — true for
   * the active tab's profile only. Reconnections never wake (a dropped socket
   * most often means the machine went to sleep because nobody used it). */
  wake: boolean;
  onChange: (state: ProfilePlanUsage) => void;
  /** The client's clock, for `receivedAt`. */
  now?: () => number;
  /**
   * Ping on a timer while the window is visible, on top of the pings sent on
   * a refresh and on coming back to the foreground. Off for a profile behind
   * a broker: a frame towards a paid host counts as someone being there and
   * keeps its machine from idling — the reason the sidebar's own probe never
   * runs on a timer (`useForegroundSync`'s `poll` makes the same cut).
   */
  periodicPing?: boolean;
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
 *
 * A socket whose other end vanished without a close frame (a NAT mapping or
 * a tunnel dropped, the machine slept) still reads as OPEN here forever, and
 * a refresh sent on it goes nowhere. So the socket proves itself alive with
 * `ping` → `pong`: on every refresh, on coming back to the foreground and,
 * where allowed, on a timer. A missing `pong` drops it and redials at once,
 * and a refresh that was in flight is sent again on the new connection.
 */
export class PlanUsageWatch {
  private state: ProfilePlanUsage = EMPTY_PROFILE_USAGE;
  private socket: WebSocket | undefined;
  private retryTimer: number | undefined;
  private refreshTimer: number | undefined;
  private pongTimer: number | undefined;
  private pingTimer: number | undefined;
  /** The refresh not answered yet, kept to be sent again if its socket dies. */
  private pendingRefresh: { message: PlanUsageRefreshMessage; resends: number } | undefined;
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
    this.clearLiveness();
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
    if (this.stopped || this.final || this.resolving) return;
    // Connected: a socket that looks fine may be dead — prove it.
    if (this.socket) {
      this.probe();
      return;
    }
    window.clearTimeout(this.retryTimer);
    this.connect(options.wake);
  }

  /**
   * Sends `plan_usage_refresh` and pings alongside it, so a dead socket is
   * found within `PONG_TIMEOUT_MS` instead of the refresh vanishing. Not
   * connected right now: the refresh waits for the next connection, which is
   * dialed at once. False only on a final state (old relay, revoked).
   */
  refresh(force: boolean, runtime?: PlanUsageRuntime): boolean {
    if (this.stopped || this.final) return false;
    const message: PlanUsageRefreshMessage = { type: "plan_usage_refresh", force, ...(runtime ? { runtime } : {}) };
    this.pendingRefresh = { message, resends: 0 };
    this.update({ refreshing: true });
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.pendingRefresh = undefined;
      this.update({ refreshing: false });
    }, REFRESH_TIMEOUT_MS);
    const socket = this.socket;
    if (this.state.connection === "live" && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      this.probe();
    } else if (!this.socket && !this.resolving) {
      window.clearTimeout(this.retryTimer);
      this.connect(false);
    }
    return true;
  }

  /** `ping` now, unless one is already waiting for its `pong`. */
  private probe(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.state.connection !== "live" || this.pongTimer !== undefined) return;
    socket.send(JSON.stringify({ type: "ping" }));
    this.pongTimer = window.setTimeout(() => {
      this.pongTimer = undefined;
      if (this.socket !== socket) return;
      // Silent: dead. Detached before closing, so its own `close` (if it
      // ever fires on a dead connection) doesn't schedule a second redial.
      this.socket = undefined;
      this.clearLiveness();
      socket.close();
      this.update({ connection: "offline" });
      this.connect(false);
    }, PONG_TIMEOUT_MS);
  }

  private clearLiveness(): void {
    window.clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
    window.clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private startPeriodicPing(): void {
    if (!this.options.periodicPing || this.pingTimer !== undefined) return;
    this.pingTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") this.probe();
    }, PING_INTERVAL_MS);
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
      if (!message && messageType(event.data) === "pong") {
        window.clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        return;
      }
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
      const first = !answered;
      answered = true;
      this.failures = 0;
      // Any message is as good as a pong.
      window.clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      this.startPeriodicPing();
      const pending = this.pendingRefresh;
      if (first && pending) {
        // A new connection with a refresh still owed: its first state is
        // the snapshot, not the answer. Send the refresh (again) on it.
        if (pending.resends < REFRESH_RESENDS) {
          pending.resends += 1;
          ws.send(JSON.stringify(pending.message));
          this.update({ connection: "live", runtimes: message.runtimes, observedAt: message.observedAt, receivedAt: this.now() });
          return;
        }
        this.pendingRefresh = undefined;
      } else {
        this.pendingRefresh = undefined;
      }
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
      this.clearLiveness();
      // A refresh still owed keeps its spinner: it is sent again on the next
      // connection, or given up on by its own timeout.
      this.update({ connection: "offline" });
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
