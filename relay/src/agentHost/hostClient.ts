// The relay's side of the agent host socket: connects, handshakes, keeps
// reconnecting with backoff, and keeps each subscription streaming across
// reconnects without losing or repeating an event.
//
// Delivery from the host is at-least-once (a reconnect resumes from the
// cursor this client last advanced, and a replay can overlap what was
// already seen); this class turns it into exactly-once per subscription by
// dropping any record whose `seq` is not above the last one delivered.
// Across a restart of the relay process itself, the consumer is the one who
// knows what it durably processed — it passes that cursor back in to
// `subscribe` (`FileCursorStore` is a ready-made place to keep it).
import { EventEmitter } from "node:events";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, type Stats } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  AGENT_HOST_PROTOCOL_VERSION,
  encodeMessage,
  parseHostMessage,
  type AgentActivity,
  type ClientMessage,
  type ErrorPayload,
  type EventMessage,
  type HelloRefusedMessage,
  type HostMessage,
  type ReplayGapMessage,
  type SubscribeResult,
} from "./protocol.js";
import { RELEASE_VERSION } from "./release.js";

/** `unsafe`: the socket or its directory is not private to this user, so
 * nothing was sent to it (see `untrustedSocketReason`). */
export type HostClientStatus = "connecting" | "connected" | "disconnected" | "refused" | "unsafe" | "closed";

/** Where a subscription stands: the offset to resume from, the last `seq`
 * delivered (-1 before any), and which incarnation of the agent's log those
 * refer to (unknown before the first subscribe answered). */
export interface AgentCursor {
  readonly nextOffset: number;
  readonly lastSeq: number;
  readonly incarnation?: string;
}

export const START_OF_LOG: AgentCursor = { nextOffset: 0, lastSeq: -1 };

export interface SubscriptionHandlers {
  onEvent(event: EventMessage): void;
  /** Records were dropped by the host's retention before this client read
   * them; what lay between is only in the agent CLI's own transcript. */
  onGap?(gap: ReplayGapMessage): void;
  /** The replay reached the live end (once per connection). */
  onCaughtUp?(nextOffset: number): void;
  /** The subscription ended: the host refused it (e.g. unknown agent), or
   * the agent was removed (`code: "removed"`). It is dropped. */
  onError?(error: ErrorPayload): void;
}

export interface HostSubscription {
  cursor(): AgentCursor;
  close(): void;
}

/**
 * Why the socket at `socketPath` must not be trusted, or `undefined`. The
 * host creates it 0600 inside a 0700 directory it owns; anything else could
 * be another user's socket planted where ours is expected (the fallback
 * directory under /tmp has a predictable name), and the relay would hand it
 * agent specs and messages. A socket that does not exist yet is not
 * untrusted — the connect simply fails and is retried.
 */
export function untrustedSocketReason(socketPath: string): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const check = (path: string, what: string, isRightKind: (info: Stats) => boolean): string | undefined => {
    let info: Stats;
    try {
      info = lstatSync(path);
    } catch {
      return undefined;
    }
    if (!isRightKind(info)) return `${what} ${path} is not what it should be`;
    if (info.uid !== uid) return `${what} ${path} belongs to uid ${info.uid}, not ${uid}`;
    if ((info.mode & 0o077) !== 0) return `${what} ${path} is open to other users (mode ${(info.mode & 0o777).toString(8)})`;
    return undefined;
  };
  return check(dirname(socketPath), "directory", (info) => info.isDirectory()) ?? check(socketPath, "socket", (info) => info.isSocket());
}

export class HostUnavailableError extends Error {
  constructor(message = "agent host is not connected") {
    super(message);
    this.name = "HostUnavailableError";
  }
}

export class HostRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HostRequestError";
  }
}

export interface HostClientOptions {
  readonly socketPath: string;
  readonly clientName?: string;
  /** Only so a test can play a client from another release. */
  readonly protocolVersion?: number;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  readonly requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface SubscriptionState {
  readonly agentId: string;
  cursor: AgentCursor;
  /** Id of the subscribe currently in force; streamed messages carrying any
   * other belong to a replaced subscription and are dropped. */
  sub?: number;
  readonly handlers: SubscriptionHandlers;
  closed: boolean;
}

export interface HostClientEvents {
  status: [HostClientStatus];
  agent_state: [AgentActivity];
  refused: [HelloRefusedMessage];
}

export class HostClient extends EventEmitter<HostClientEvents> {
  private socket: Socket | undefined;
  private statusValue: HostClientStatus = "disconnected";
  private hostReleaseValue: string | undefined;
  private inbound = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private reconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private started = false;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: HostClientOptions) {
    super();
    this.reconnectMinMs = options.reconnectMinMs ?? 100;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.reconnectDelay = this.reconnectMinMs;
  }

  get status(): HostClientStatus {
    return this.statusValue;
  }

  /** The connected host's release, once the handshake succeeded. */
  get hostRelease(): string | undefined {
    return this.hostReleaseValue;
  }

  /** Starts connecting; keeps reconnecting until `close()`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.connectNow();
  }

  /** Resolves once connected, rejects after `timeoutMs`. */
  waitUntilConnected(timeoutMs = 5000): Promise<void> {
    if (this.statusValue === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("status", onStatus);
        reject(new HostUnavailableError(`agent host not connected within ${timeoutMs}ms (status: ${this.statusValue})`));
      }, timeoutMs);
      const onStatus = (status: HostClientStatus): void => {
        if (status !== "connected") return;
        clearTimeout(timer);
        this.off("status", onStatus);
        resolve();
      };
      this.on("status", onStatus);
    });
  }

  close(): void {
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.failPending(new HostUnavailableError("agent host client closed"));
    this.setStatus("closed");
  }

  /** One request/response. Not retried on a disconnect: the caller decides
   * whether the operation is safe to repeat. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.statusValue !== "connected" || !this.socket) return Promise.reject(new HostUnavailableError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostRequestError("timeout", `agent host did not answer ${method} within ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ op: "request", id, method, params });
    });
  }

  /** Streams one agent's log from `from`, now and after every reconnect,
   * until closed. One subscription per agent per client. */
  subscribe(agentId: string, from: AgentCursor, handlers: SubscriptionHandlers): HostSubscription {
    this.subscriptions.get(agentId)?.handlers.onError?.({ code: "replaced", message: "a newer subscription replaced this one" });
    const state: SubscriptionState = { agentId, cursor: from, handlers, closed: false };
    this.subscriptions.set(agentId, state);
    if (this.statusValue === "connected") this.sendSubscribe(state);
    return {
      cursor: () => state.cursor,
      close: () => {
        if (state.closed) return;
        state.closed = true;
        if (this.subscriptions.get(agentId) === state) {
          this.subscriptions.delete(agentId);
          if (this.statusValue === "connected") this.write({ op: "unsubscribe", id: this.nextId++, agentId });
        }
      },
    };
  }

  private sendSubscribe(state: SubscriptionState): void {
    const id = this.nextId++;
    state.sub = id;
    this.pending.set(id, {
      resolve: (value) => {
        if (state.closed || state.sub !== id) return;
        const result = value as SubscribeResult;
        state.cursor = result.reset
          ? { nextOffset: result.firstOffset, lastSeq: -1, incarnation: result.incarnation }
          : { ...state.cursor, incarnation: result.incarnation };
      },
      reject: (error) => {
        if (state.closed || this.subscriptions.get(state.agentId) !== state) return;
        if (error instanceof HostRequestError) {
          this.subscriptions.delete(state.agentId);
          state.closed = true;
          state.handlers.onError?.({ code: error.code, message: error.message });
        }
      },
      timer: setTimeout(() => {
        if (!this.pending.delete(id) || state.closed || state.sub !== id) return;
        state.closed = true;
        if (this.subscriptions.get(state.agentId) === state) this.subscriptions.delete(state.agentId);
        state.handlers.onError?.({ code: "timeout", message: `agent host did not answer the subscription to ${state.agentId} within ${this.requestTimeoutMs}ms` });
      }, this.requestTimeoutMs),
    });
    this.write({ op: "subscribe", id, agentId: state.agentId, fromOffset: state.cursor.nextOffset, incarnation: state.cursor.incarnation });
  }

  private write(message: ClientMessage): void {
    this.socket?.write(encodeMessage(message));
  }

  private setStatus(status: HostClientStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.emit("status", status);
  }

  private connectNow(): void {
    this.reconnectTimer = undefined;
    if (!this.started) return;
    const untrusted = untrustedSocketReason(this.options.socketPath);
    if (untrusted) {
      if (this.statusValue !== "unsafe") console.error(`[relay] not connecting to the agent host: ${untrusted}`);
      this.setStatus("unsafe");
      this.reconnectTimer = setTimeout(() => this.connectNow(), this.reconnectMaxMs);
      this.reconnectTimer.unref();
      return;
    }
    this.setStatus("connecting");
    this.inbound = "";
    const socket = connect(this.options.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        encodeMessage({ op: "hello", version: this.options.protocolVersion ?? AGENT_HOST_PROTOCOL_VERSION, client: this.options.clientName, release: RELEASE_VERSION }),
      );
    });
    socket.on("data", (chunk: string) => {
      if (this.socket !== socket) return;
      this.inbound += chunk;
      let newline: number;
      while ((newline = this.inbound.indexOf("\n")) >= 0) {
        const line = this.inbound.slice(0, newline);
        this.inbound = this.inbound.slice(newline + 1);
        if (line.trim()) this.onLine(line);
        if (this.socket !== socket) return;
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.failPending(new HostUnavailableError("agent host connection closed"));
      if (this.statusValue !== "refused") this.setStatus("disconnected");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const delay = this.statusValue === "refused" ? this.reconnectMaxMs : this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => this.connectNow(), delay);
    this.reconnectTimer.unref();
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private onLine(line: string): void {
    const parsed = parseHostMessage(line);
    if (!parsed.ok) return;
    this.onMessage(parsed.message);
  }

  private onMessage(message: HostMessage): void {
    switch (message.type) {
      case "hello_ok":
        this.hostReleaseValue = message.release;
        this.reconnectDelay = this.reconnectMinMs;
        this.setStatus("connected");
        for (const state of this.subscriptions.values()) this.sendSubscribe(state);
        return;
      case "hello_refused":
        console.error(
          `[relay] agent host refused the connection: ${message.reason} (host protocol ${message.hostVersion}, release ${message.hostRelease ?? "unknown"}; ours ${this.options.protocolVersion ?? AGENT_HOST_PROTOCOL_VERSION}, release ${RELEASE_VERSION}) — the relay and the agent host must come from the same release; restart the one that is older`,
        );
        this.setStatus("refused");
        this.emit("refused", message);
        this.socket?.destroy();
        return;
      case "response": {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.ok) request.resolve(message.result);
        else request.reject(new HostRequestError(message.error.code, message.error.message));
        return;
      }
      case "event": {
        const state = this.subscriptions.get(message.agentId);
        if (!state || state.closed || message.sub !== state.sub) return;
        if (message.seq <= state.cursor.lastSeq) {
          // Already delivered (an overlapping replay); keep the furthest cursor.
          return;
        }
        state.cursor = { nextOffset: message.next, lastSeq: message.seq, incarnation: state.cursor.incarnation };
        try {
          state.handlers.onEvent(message);
        } catch (error) {
          console.error(`[relay] agent ${message.agentId} event handler threw:`, (error as Error).message);
        }
        return;
      }
      case "replay_gap": {
        const state = this.subscriptions.get(message.agentId);
        if (!state || state.closed || message.sub !== state.sub) return;
        state.cursor = { ...state.cursor, nextOffset: message.resumeOffset };
        state.handlers.onGap?.(message);
        return;
      }
      case "caught_up": {
        const state = this.subscriptions.get(message.agentId);
        if (!state || state.closed || message.sub !== state.sub) return;
        state.handlers.onCaughtUp?.(message.nextOffset);
        return;
      }
      case "stream_closed": {
        const state = this.subscriptions.get(message.agentId);
        if (!state || state.closed || message.sub !== state.sub) return;
        state.closed = true;
        this.subscriptions.delete(message.agentId);
        state.handlers.onError?.({ code: message.reason, message: `agent ${message.agentId} was ${message.reason}` });
        return;
      }
      case "agent_state":
        this.emit("agent_state", message.agent);
        return;
    }
  }
}

/**
 * Per-agent cursors kept in one JSON file (written atomically), for a
 * consumer that needs to resume after its own process restarts. `set` is
 * cheap and coalesces writes; `flush` writes now. A cursor that lags behind
 * what was processed only means a replay overlap, which `HostClient` dedupes
 * as long as the consumer's own state (not this file) is what it trusts for
 * "already handled" across a restart.
 */
export class FileCursorStore {
  private cursors: Record<string, AgentCursor>;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly path: string,
    private readonly debounceMs = 200,
  ) {
    this.cursors = {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    // Only entries of the right shape: a bad cursor would silently skip or
    // repeat an agent's events.
    for (const [agentId, value] of Object.entries(parsed)) {
      const cursor = value as Partial<AgentCursor> | null;
      if (
        typeof cursor === "object" &&
        cursor !== null &&
        Number.isSafeInteger(cursor.nextOffset) &&
        (cursor.nextOffset as number) >= 0 &&
        Number.isSafeInteger(cursor.lastSeq) &&
        (cursor.lastSeq as number) >= -1 &&
        (cursor.incarnation === undefined || typeof cursor.incarnation === "string")
      ) {
        this.cursors[agentId] = {
          nextOffset: cursor.nextOffset as number,
          lastSeq: cursor.lastSeq as number,
          ...(cursor.incarnation !== undefined ? { incarnation: cursor.incarnation } : {}),
        };
      }
    }
  }

  get(agentId: string): AgentCursor | undefined {
    return this.cursors[agentId];
  }

  set(agentId: string, cursor: AgentCursor): void {
    this.cursors[agentId] = cursor;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.debounceMs);
      this.timer.unref();
    }
  }

  delete(agentId: string): void {
    delete this.cursors[agentId];
    this.flush();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cursors), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
