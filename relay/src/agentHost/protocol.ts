// Wire protocol between the relay (client) and the agent host (server), over
// a unix socket, one JSON value per line in both directions.
//
// The host is a separate process from the relay so agents survive a relay
// restart; the two are shipped in the same release artifact, but a relay and
// a host from different releases can still meet during an upgrade (one
// service restarted, the other not yet). That is why the first message is
// always `hello` with the protocol version, and why a mismatch is refused
// explicitly (`hello_refused`) instead of being half-understood: a relay that
// misreads an event shape would corrupt what it shows without any error.
//
// Bump AGENT_HOST_PROTOCOL_VERSION on any change a peer from the previous
// release could misinterpret (a renamed field, a changed meaning). Adding an
// optional field that an older peer can ignore does not need a bump.
//
// Pure: no I/O here, so the parsing rules are testable as a table.

export const AGENT_HOST_PROTOCOL_VERSION = 1;

/** Agent ids end up in file names and process environments. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Ids the host uses for its own processes' marks. */
const RESERVED_AGENT_IDS = new Set(["codex-app-server"]);

export function isValidAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID_PATTERN.test(value) && !RESERVED_AGENT_IDS.has(value);
}

// ---------------------------------------------------------------- client → host

export interface HelloMessage {
  readonly op: "hello";
  readonly version: number;
  /** Free text for the host's log only. */
  readonly client?: string;
  /** The client's release, informational (see `HelloOkMessage.release`). */
  readonly release?: string;
}

/** Starts (or resumes) streaming one agent's log to this connection: every
 * record whose offset is at or after `fromOffset`, then live records as they
 * are appended. Offsets are logical byte positions in the agent's log; the
 * `next` of the last record a client processed is the value to resume from. */
export interface SubscribeMessage {
  readonly op: "subscribe";
  /** Also the subscription's id: every message streamed for it carries it
   * as `sub`, so records still in flight for a replaced subscription are
   * told apart from the new one's. */
  readonly id: number;
  readonly agentId: string;
  readonly fromOffset: number;
  /** The log incarnation `fromOffset` refers to. A different one (the agent
   * was removed and recreated) makes the host stream from the start of the
   * current log and answer `reset: true`. */
  readonly incarnation?: string;
}

export interface UnsubscribeMessage {
  readonly op: "unsubscribe";
  readonly id: number;
  readonly agentId: string;
}

/** Every other operation: request/response, correlated by `id`. */
export interface RequestMessage {
  readonly op: "request";
  readonly id: number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type ClientMessage = HelloMessage | SubscribeMessage | UnsubscribeMessage | RequestMessage;

// ---------------------------------------------------------------- host → client

export interface HelloOkMessage {
  readonly type: "hello_ok";
  readonly version: number;
  readonly hostPid: number;
  /** The profile (or test instance) this host serves. */
  readonly hostId: string;
  /** The host's release (package version). Informational: compatibility is
   * decided by `version` alone. */
  readonly release?: string;
}

export interface HelloRefusedMessage {
  readonly type: "hello_refused";
  readonly reason: "protocol_version_mismatch" | "hello_required";
  readonly hostVersion: number;
  readonly clientVersion?: number;
  readonly hostRelease?: string;
}

export interface ErrorPayload {
  /** Stable, machine-readable. */
  readonly code: string;
  readonly message: string;
}

export type ResponseMessage =
  | { readonly type: "response"; readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly type: "response"; readonly id: number; readonly ok: false; readonly error: ErrorPayload };

/** One record of an agent's log. `ev` is the agent CLI's own event verbatim,
 * or one of the host's own `host_*` events (see `HostEvent`). */
export interface EventRecord {
  readonly seq: number;
  readonly off: number;
  /** Offset of the record after this one: what a client resumes from. */
  readonly next: number;
  /** Epoch ms when the host received the line. */
  readonly t: number;
  readonly ev: Record<string, unknown>;
}

export interface EventMessage extends EventRecord {
  readonly type: "event";
  readonly agentId: string;
  readonly sub: number;
}

/** The requested offset is no longer in the log (retention dropped it), or is
 * past its end. Streaming continues from `resumeOffset`; whatever lay between
 * is only recoverable from the agent CLI's own transcript. */
export interface ReplayGapMessage {
  readonly type: "replay_gap";
  readonly agentId: string;
  readonly sub: number;
  readonly requestedOffset: number;
  readonly resumeOffset: number;
  readonly reason: "truncated" | "ahead";
}

/** Sent once per subscription, when the replay has reached the end of the log
 * and everything after this is live. */
export interface CaughtUpMessage {
  readonly type: "caught_up";
  readonly agentId: string;
  readonly sub: number;
  readonly nextOffset: number;
}

/** The subscription ended on the host's side (the agent was removed). */
export interface StreamClosedMessage {
  readonly type: "stream_closed";
  readonly agentId: string;
  readonly sub: number;
  readonly reason: "removed";
}

/** What a subscribe is answered with (before anything is streamed). */
export interface SubscribeResult {
  readonly firstOffset: number;
  readonly endOffset: number;
  readonly incarnation: string;
  /** The requested incarnation was not the current one: streaming starts at
   * `firstOffset` of the current log. */
  readonly reset: boolean;
}

/** Pushed to every connection after any change of an agent's activity. */
export interface AgentStateMessage {
  readonly type: "agent_state";
  readonly agent: AgentActivity;
}

export type HostMessage =
  | HelloOkMessage
  | HelloRefusedMessage
  | ResponseMessage
  | EventMessage
  | ReplayGapMessage
  | CaughtUpMessage
  | StreamClosedMessage
  | AgentStateMessage;

// ---------------------------------------------------------------- agent model

/**
 * The semantic state of one agent, as the relay and whatever watches the
 * machine's activity need it:
 *
 * - `starting`: the process is coming up for a turn.
 * - `working`: a turn is in flight (including a tool waiting on a bridged
 *   approval: the turn has not ended).
 * - `awaiting_user`: the last turn ended with a question for the person
 *   (the relay marks it, it owns the pending question); no process needs to
 *   stay alive for this.
 * - `idle`: the process is alive between turns.
 * - `hibernated`: no process; the session is kept by its id and the next
 *   message resumes it transparently.
 * - `stopped`: no process because someone stopped it, or the host restarted
 *   and did not bring it back on its own. Resumable when `resumable`.
 * - `failed`: the process died on its own. Resumable when `resumable`.
 */
export type AgentState = "starting" | "working" | "awaiting_user" | "idle" | "hibernated" | "stopped" | "failed";

export type AgentRuntimeId = "claude" | "codex";

export type StopReason = "user" | "host_restart" | "host_shutdown";

export interface AgentActivity {
  readonly agentId: string;
  readonly runtime: AgentRuntimeId;
  readonly roomId?: string;
  readonly state: AgentState;
  /** Whether a process is holding this agent right now. */
  readonly alive: boolean;
  readonly pid?: number;
  readonly sessionId?: string;
  /** Whether a new message can bring it back (it has a session to resume). */
  readonly resumable: boolean;
  readonly awaitingUser: boolean;
  /** Background tasks (native subagents, background shell jobs) the CLI
   * reported as still running. A non-empty list keeps the agent from being
   * hibernated even when no turn is in flight. */
  readonly backgroundTasks: number;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly turnStartedAt?: number;
  readonly lastTurnEndedAt?: number;
  readonly stopReason?: StopReason;
  readonly failure?: string;
  /** End of this agent's log: what a subscriber that is fully caught up has
   * as its cursor. */
  readonly nextOffset: number;
}

/** The host's own events, written to an agent's log next to the CLI's. */
export type HostEvent =
  | { readonly type: "host_user_message"; readonly text: string; readonly duringTurn: boolean }
  | { readonly type: "host_process"; readonly subtype: "spawned"; readonly pid: number; readonly resumed: boolean }
  | { readonly type: "host_process"; readonly subtype: "exited"; readonly code: number | null; readonly signal: string | null; readonly expected: boolean }
  | { readonly type: "host_process"; readonly subtype: "stop_begin" | "killed" | "hibernating" }
  /** The host that ran this agent's process went away without stopping it
   * (crash, SIGKILL, reboot); written when the next host starts. */
  | { readonly type: "host_process"; readonly subtype: "lost" }
  | { readonly type: "host_interrupt" };

// ---------------------------------------------------------------- framing

export function encodeMessage(message: HostMessage | ClientMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** On failure, `id` is the request id when one could be read, so the error
 * can still be answered to whoever is waiting on it. */
export type ParseResult<T> = { readonly ok: true; readonly message: T } | { readonly ok: false; readonly error: string; readonly id?: number };

/** Validates one line received by the host. Never throws. */
export function parseClientMessage(line: string): ParseResult<ClientMessage> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, error: "bad_json" };
  }
  if (!isRecord(value)) return { ok: false, error: "not_an_object" };
  const id = isRequestId(value.id) ? value.id : undefined;
  switch (value.op) {
    case "hello":
      if (typeof value.version !== "number") return { ok: false, error: "bad_hello" };
      return {
        ok: true,
        message: {
          op: "hello",
          version: value.version,
          client: typeof value.client === "string" ? value.client : undefined,
          release: typeof value.release === "string" ? value.release : undefined,
        },
      };
    case "subscribe":
      if (!isRequestId(value.id) || !isValidAgentId(value.agentId)) return { ok: false, error: "bad_subscribe", id };
      if (typeof value.fromOffset !== "number" || !Number.isSafeInteger(value.fromOffset) || value.fromOffset < 0) {
        return { ok: false, error: "bad_subscribe", id };
      }
      return {
        ok: true,
        message: {
          op: "subscribe",
          id: value.id,
          agentId: value.agentId,
          fromOffset: value.fromOffset,
          incarnation: typeof value.incarnation === "string" ? value.incarnation : undefined,
        },
      };
    case "unsubscribe":
      if (!isRequestId(value.id) || !isValidAgentId(value.agentId)) return { ok: false, error: "bad_unsubscribe", id };
      return { ok: true, message: { op: "unsubscribe", id: value.id, agentId: value.agentId } };
    case "request":
      if (!isRequestId(value.id) || typeof value.method !== "string") return { ok: false, error: "bad_request" };
      return { ok: true, message: { op: "request", id: value.id, method: value.method, params: isRecord(value.params) ? value.params : {} } };
    default:
      return { ok: false, error: "unknown_op", id };
  }
}

/** Validates one line received by the client. Never throws; anything it does
 * not recognize is reported rather than guessed at. */
export function parseHostMessage(line: string): ParseResult<HostMessage> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, error: "bad_json" };
  }
  if (!isRecord(value) || typeof value.type !== "string") return { ok: false, error: "not_a_message" };
  switch (value.type) {
    case "hello_ok":
    case "hello_refused":
    case "response":
    case "event":
    case "replay_gap":
    case "caught_up":
    case "stream_closed":
    case "agent_state":
      return { ok: true, message: value as unknown as HostMessage };
    default:
      return { ok: false, error: "unknown_type" };
  }
}

/** A stable error the host answers a request with. */
export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}
