// The agent host's unix socket: handshake, request/response, and streaming
// each agent's log to subscribers.
//
// Streaming has two modes per subscription, and a subscription moves between
// them freely:
//   - catch-up: records are read from disk in bounded chunks (`LogReader`)
//     and written while the socket's outbound buffer stays under
//     `highWaterBytes`; past it, the reader waits for `drain`.
//   - live: each record is written as the log appends it.
// A live subscriber whose outbound buffer grows past `highWaterBytes` (a slow
// or stalled client) is moved back to catch-up at its cursor instead of
// buffering without bound: the log on disk is the source of truth, so
// nothing is lost and the host's memory per connection stays bounded.
// Catch-up switches to live in the same tick it sees the cursor equal to the
// log's end, and appends are synchronous, so the switch has no gap and no
// duplicate.
//
// Security: the socket lives in a directory only this user can enter (0700,
// created or tightened here, refused if owned by someone else), and the
// socket file itself is 0600. Node exposes no SO_PEERCRED, so the peer's uid
// is not checked separately; the permissions are the access control, the
// same trust boundary as the user's own files.
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { LogReader, type AgentEventLog, type RawRecord } from "./eventLog.js";
import { StringLineSplitter } from "./lineSplitter.js";
import { AGENT_HOST_PROTOCOL_VERSION, HostError, encodeMessage, parseClientMessage, type HostMessage, type SubscribeResult } from "./protocol.js";
import { RELEASE_VERSION } from "./release.js";

export const DEFAULT_HIGH_WATER_BYTES = 1024 * 1024;
/** A connection this far behind gets no more `agent_state` broadcasts (the
 * only messages written without the high-water check); it can ask for
 * `activity` once it catches up. Event records are bounded by the log's
 * per-record cap and the high-water mark, so nothing else can grow it. */
const STUCK_CONNECTION_BYTES = 32 * 1024 * 1024;
const MAX_INBOUND_LINE_BYTES = 16 * 1024 * 1024;

export interface SocketServerOptions {
  readonly socketPath: string;
  readonly hostId: string;
  /** Returns the log of a known agent, `undefined` otherwise. */
  readonly logFor: (agentId: string) => AgentEventLog | undefined;
  readonly handleRequest: (method: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly highWaterBytes?: number;
  readonly replayChunkBytes?: number;
  /** Protocol version this server speaks — overridable only so a test can
   * stand up a host from "another release". */
  readonly protocolVersion?: number;
}

/** Makes `dir` private to this user, creating it if needed. Refuses a
 * directory owned by another user rather than trusting it. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`${dir} is owned by uid ${info.uid}, not ${uid}`);
  if ((info.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function probeListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

function eventWireLine(agentId: string, sub: number, record: RawRecord): string {
  // The stored line is `{"seq":..,"off":..,"t":..,"ev":..}`; splice the
  // envelope fields in front of it instead of re-serializing `ev`, which can
  // be a large tool result.
  return `{"type":"event","agentId":${JSON.stringify(agentId)},"sub":${sub},"next":${record.next},${record.line.slice(1)}\n`;
}

class Subscription {
  private mode: "catchup" | "live" | "closed" = "catchup";
  private reader: LogReader | undefined;
  private stopLive: (() => void) | undefined;
  private sentCaughtUp = false;
  private cursor: number;

  constructor(
    private readonly connection: Connection,
    readonly agentId: string,
    private readonly log: AgentEventLog,
    fromOffset: number,
    readonly sub: number,
  ) {
    this.cursor = fromOffset;
  }

  start(): void {
    this.enterCatchUp();
  }

  private enterCatchUp(): void {
    this.stopLive?.();
    this.stopLive = undefined;
    this.mode = "catchup";
    this.reader = new LogReader(this.log, this.cursor);
    void this.catchUp(this.reader).catch((error: unknown) => {
      console.error(`[agent-host] replay of ${this.agentId} failed:`, (error as Error).message);
      this.connection.destroy();
    });
  }

  private async catchUp(reader: LogReader): Promise<void> {
    while (this.mode === "catchup" && this.reader === reader) {
      await this.connection.waitBelowHighWater();
      if (this.mode !== "catchup" || this.reader !== reader) return;
      const step = await reader.step(this.connection.replayChunkBytes);
      if (this.mode !== "catchup" || this.reader !== reader) return;
      switch (step.kind) {
        case "gap":
          this.cursor = step.resumeOffset;
          this.connection.send({ type: "replay_gap", agentId: this.agentId, sub: this.sub, requestedOffset: step.requestedOffset, resumeOffset: step.resumeOffset, reason: step.reason });
          break;
        case "records":
          for (const record of step.records) {
            this.connection.write(eventWireLine(this.agentId, this.sub, record));
            this.cursor = record.next;
          }
          break;
        case "end":
          // Synchronous from here to the subscription: no append can land
          // between this comparison and `onAppend`.
          if (reader.cursor === this.log.endOffset) {
            this.cursor = reader.cursor;
            void reader.close();
            this.reader = undefined;
            this.mode = "live";
            this.stopLive = this.log.onAppend((record) => this.onLive(record));
            if (!this.sentCaughtUp) {
              this.sentCaughtUp = true;
              this.connection.send({ type: "caught_up", agentId: this.agentId, sub: this.sub, nextOffset: this.cursor });
            }
            return;
          }
          break;
      }
    }
  }

  private onLive(record: RawRecord): void {
    if (this.mode !== "live") return;
    if (record.off !== this.cursor || this.connection.aboveHighWater()) {
      // Slow consumer (or a cursor that somehow drifted): stop pushing and
      // let catch-up read it from disk once the socket drains.
      this.enterCatchUp();
      return;
    }
    this.connection.write(eventWireLine(this.agentId, this.sub, record));
    this.cursor = record.next;
  }

  close(): void {
    this.mode = "closed";
    this.stopLive?.();
    this.stopLive = undefined;
    const reader = this.reader;
    this.reader = undefined;
    if (reader) void reader.close();
  }
}

class Connection {
  private helloed = false;
  private readonly inbound = new StringLineSplitter();
  private readonly subscriptions = new Map<string, Subscription>();
  private drainWaiters: (() => void)[] = [];
  private destroyed = false;
  /** Refused at the handshake: the socket is ending, ignore anything else. */
  private ending = false;

  constructor(
    private readonly server: AgentHostSocketServer,
    private readonly socket: Socket,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("drain", () => this.flushDrainWaiters());
    socket.on("error", () => {});
    socket.on("close", () => this.onClose());
  }

  get replayChunkBytes(): number {
    return this.server.replayChunkBytes;
  }

  get isHelloed(): boolean {
    return this.helloed && !this.destroyed;
  }

  get bufferedBytes(): number {
    return this.socket.writableLength;
  }

  aboveHighWater(): boolean {
    return this.socket.writableLength > this.server.highWaterBytes;
  }

  waitBelowHighWater(): Promise<void> {
    if (this.destroyed || !this.aboveHighWater()) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private flushDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  write(text: string): void {
    if (this.destroyed) return;
    this.socket.write(text);
  }

  send(message: HostMessage): void {
    this.write(encodeMessage(message));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.socket.destroy();
    this.onClose();
  }

  closeSubscription(agentId: string, reason?: "removed"): void {
    const subscription = this.subscriptions.get(agentId);
    if (!subscription) return;
    subscription.close();
    this.subscriptions.delete(agentId);
    if (reason) this.send({ type: "stream_closed", agentId, sub: subscription.sub, reason });
  }

  private onClose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const subscription of this.subscriptions.values()) subscription.close();
    this.subscriptions.clear();
    this.flushDrainWaiters();
    this.server.forget(this);
  }

  private onData(chunk: string): void {
    for (const line of this.inbound.push(chunk)) {
      if (this.destroyed || this.ending) return;
      if (line.trim()) this.onLine(line);
    }
    // A client message is small; an endless line is not a client.
    if (this.inbound.pendingLength > MAX_INBOUND_LINE_BYTES) this.destroy();
  }

  private onLine(line: string): void {
    const parsed = parseClientMessage(line);
    if (!this.helloed) {
      const version = this.server.protocolVersion;
      if (!parsed.ok || parsed.message.op !== "hello") {
        this.send({ type: "hello_refused", reason: "hello_required", hostVersion: version });
        this.socket.end();
        this.ending = true;
        return;
      }
      if (parsed.message.version !== version) {
        console.error(
          `[agent-host] refused a client speaking protocol ${parsed.message.version} (release ${parsed.message.release ?? "unknown"}); this host speaks ${version} (release ${RELEASE_VERSION})`,
        );
        this.send({ type: "hello_refused", reason: "protocol_version_mismatch", hostVersion: version, clientVersion: parsed.message.version, hostRelease: RELEASE_VERSION });
        this.socket.end();
        this.ending = true;
        return;
      }
      this.helloed = true;
      this.send({ type: "hello_ok", version, hostPid: process.pid, hostId: this.server.hostId, release: RELEASE_VERSION });
      return;
    }
    if (!parsed.ok) {
      // Answer whoever is waiting on it; with no id there is no one to tell.
      if (parsed.id !== undefined) this.send({ type: "response", id: parsed.id, ok: false, error: { code: "bad_request", message: parsed.error } });
      return;
    }
    const message = parsed.message;
    switch (message.op) {
      case "hello":
        return;
      case "subscribe": {
        const log = this.server.logFor(message.agentId);
        if (!log) {
          this.send({ type: "response", id: message.id, ok: false, error: { code: "unknown_agent", message: `no agent ${message.agentId}` } });
          return;
        }
        this.closeSubscription(message.agentId);
        const reset = message.incarnation !== undefined && message.incarnation !== log.incarnation;
        const result: SubscribeResult = { firstOffset: log.firstOffset, endOffset: log.endOffset, incarnation: log.incarnation, reset };
        this.send({ type: "response", id: message.id, ok: true, result });
        const subscription = new Subscription(this, message.agentId, log, reset ? log.firstOffset : message.fromOffset, message.id);
        this.subscriptions.set(message.agentId, subscription);
        subscription.start();
        return;
      }
      case "unsubscribe":
        this.closeSubscription(message.agentId);
        this.send({ type: "response", id: message.id, ok: true, result: null });
        return;
      case "request":
        void this.server.dispatch(message.method, message.params).then(
          (result) => this.send({ type: "response", id: message.id, ok: true, result: result ?? null }),
          (error: unknown) => {
            const payload =
              error instanceof HostError
                ? { code: error.code, message: error.message }
                : { code: "internal", message: error instanceof Error ? error.message : String(error) };
            this.send({ type: "response", id: message.id, ok: false, error: payload });
          },
        );
        return;
    }
  }
}

export class AgentHostSocketServer {
  readonly highWaterBytes: number;
  readonly replayChunkBytes: number;
  readonly protocolVersion: number;
  private readonly connections = new Set<Connection>();

  private constructor(
    private readonly server: Server,
    private readonly options: SocketServerOptions,
  ) {
    this.highWaterBytes = options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
    this.replayChunkBytes = options.replayChunkBytes ?? 256 * 1024;
    this.protocolVersion = options.protocolVersion ?? AGENT_HOST_PROTOCOL_VERSION;
  }

  get hostId(): string {
    return this.options.hostId;
  }

  /** Binds the socket. Fails if another host is already listening on it. */
  static async listen(options: SocketServerOptions): Promise<AgentHostSocketServer> {
    ensurePrivateDir(dirname(options.socketPath));
    let stale = false;
    try {
      lstatSync(options.socketPath);
      stale = true;
    } catch {
      // nothing there
    }
    if (stale) {
      if (await probeListening(options.socketPath)) {
        throw new Error(`another agent host is already listening on ${options.socketPath}`);
      }
      unlinkSync(options.socketPath);
    }
    const server = createServer();
    const instance = new AgentHostSocketServer(server, options);
    server.on("connection", (socket) => instance.connections.add(new Connection(instance, socket)));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(options.socketPath, 0o600);
    return instance;
  }

  logFor(agentId: string): AgentEventLog | undefined {
    return this.options.logFor(agentId);
  }

  /** A handler that throws synchronously still answers with an error
   * response instead of taking the host down. */
  dispatch(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    return Promise.resolve().then(() => this.options.handleRequest(method, params));
  }

  forget(connection: Connection): void {
    this.connections.delete(connection);
  }

  /** Sends to every connection past its handshake. */
  broadcast(message: HostMessage): void {
    for (const connection of this.connections) {
      if (connection.isHelloed && connection.bufferedBytes < STUCK_CONNECTION_BYTES) connection.send(message);
    }
  }

  /** Ends every subscription to an agent and tells its subscribers why. */
  closeSubscriptions(agentId: string, reason: "removed"): void {
    for (const connection of this.connections) connection.closeSubscription(agentId, reason);
  }

  /** Outbound bytes queued in this process, per connection: diagnostics, and
   * how a test observes that a stalled client cannot grow it without bound. */
  bufferedBytes(): number[] {
    return [...this.connections].map((connection) => connection.bufferedBytes);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  async close(): Promise<void> {
    for (const connection of [...this.connections]) connection.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try {
      unlinkSync(this.options.socketPath);
    } catch {
      // already gone
    }
  }
}
