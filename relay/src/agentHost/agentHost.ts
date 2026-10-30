// The agent host: owns every agent process of one profile, records each
// agent's events in its own log, and serves both over the unix socket.
//
// The relay asks for agents by id and streams their logs; it never holds an
// agent process itself, so a relay restart leaves every agent — and any turn
// in flight — untouched.
//
// Lifecycle of the host itself:
//   - start: processes a previous run of this host left behind are ended
//     (found by an environment marker), and every agent that run had alive
//     comes back as `stopped` (`stopReason: "host_restart"`), resumable but
//     not running: nothing restarts work on its own after a crash or reboot.
//     The next message resumes the session with `--resume`.
//   - drain (SIGTERM): no new agents or messages; turns in flight get
//     `drainGraceMs` to end on their own, then are interrupted. Agents that
//     were simply idle are hibernated (they resume transparently later);
//     agents whose turn or background work had to be cut are `stopped`
//     (`host_shutdown`), so whoever watches can tell work was lost.
//
// Hibernation ends an agent's process while keeping its session, to free
// memory. Only an agent with no turn in flight and no background task still
// running is hibernated (a pending question for the person is not a turn in
// flight: the turn that asked it is over). Policies:
//   - `idle` (own machine): after `idleMs` without activity;
//   - `memory` (sized machine): only while the agents' summed PSS is above
//     `memoryFraction` of `memoryBytes`, oldest-idle first;
//   - plus a cap of live agents per room: starting one more hibernates the
//     room's oldest idle agent, or fails when none is idle.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_BIN } from "../runtimes/executables.js";
import type { AgentRuntimeDef, RoomToolCall, TurnContext } from "../runtimes/types.js";
import { ClaudeProcess, worstCaseEndMs, type ClaudeAgentSpec, type HostRoomSpec } from "./claudeProcess.js";
import { CodexPool } from "./codexPool.js";
import { AgentEventLog, type EventLogOptions } from "./eventLog.js";
import { acquireInstanceLock, type InstanceLock } from "./instanceLock.js";
import { agentProcessMap, detachedAgentProcesses, pssBytes, sweepAgentProcesses } from "./processTree.js";
import { HostError, isValidAgentId, type AgentActivity, type AgentRuntimeId, type AgentState, type HostEvent, type StopReason } from "./protocol.js";
import { AgentRegistry, type PersistedAgent, type PersistedLifecycle } from "./registry.js";
import { userCodexMcpServers } from "./codexConfig.js";
import { AGENT_HOST_DIR_MARKER, isAgentHostDirEntry } from "./paths.js";
import { AgentHostSocketServer } from "./socketServer.js";
import { CODEX_RATE_LIMITS_UPDATED_METHOD } from "../planUsage/capture.js";

export interface HibernationOptions {
  readonly policy: "idle" | "memory" | "off";
  /** `idle`: hibernate after this long without activity. Default 10 min. */
  readonly idleMs?: number;
  /** `memory`: the machine's memory budget, and the share of it the agents
   * may use before idle ones are hibernated. */
  readonly memoryBytes?: number;
  readonly memoryFraction?: number;
  /** How often the policy runs. Default 30 s. */
  readonly intervalMs?: number;
}

export interface AgentHostOptions {
  /** Profile (or test instance) id: marks every agent process, so a sweep
   * never touches another host's. */
  readonly hostId: string;
  readonly dataDir: string;
  readonly socketPath: string;
  readonly agentBin?: string;
  readonly homeOverride?: string;
  /** SIGTERM → SIGKILL grace when stopping an agent. */
  readonly stopGraceMs?: number;
  readonly hibernation?: HibernationOptions;
  /** Live agents per room. Default 10. */
  readonly maxAlivePerRoom?: number;
  /** How long a shutdown waits for turns in flight before interrupting them. */
  readonly drainGraceMs?: number;
  /** After interrupting during a drain, how long to wait for the turns to end. */
  readonly drainInterruptGraceMs?: number;
  /** After a `result`, how long a message written since the turn began may
   * still turn out to start a turn of its own (see `onLine`). */
  readonly turnSettleMs?: number;
  readonly log?: EventLogOptions;
  readonly now?: () => number;
  /** The Codex def to drive Codex agents with (tests point it at a fake
   * app-server). Default: the registered Codex def. */
  readonly codexDef?: AgentRuntimeDef;
}

interface Agent {
  readonly agentId: string;
  readonly runtime: AgentRuntimeId;
  readonly roomId?: string;
  readonly owner?: string;
  readonly spec: ClaudeAgentSpec;
  readonly createdAt: number;
  readonly log: AgentEventLog;
  sessionId?: string;
  lifecycle: PersistedLifecycle;
  proc?: ClaudeProcess;
  /** Set while the host itself is ending the process, so its exit is not
   * mistaken for a crash. */
  ending?: "stop" | "remove" | "hibernate" | "shutdown" | "log_error";
  /** Set once the agent's log failed to take a write: the agent is failed
   * for good (its history would have a hole) until it is removed. */
  logError?: string;
  /** Set as soon as a remove is accepted. Every task queued behind it checks
   * this before starting anything, so nothing runs for an agent whose log
   * is about to be deleted. */
  removed?: boolean;
  turnInFlight: boolean;
  turnStartedAt?: number;
  lastTurnEndedAt?: number;
  lastActivityAt: number;
  awaitingUser: boolean;
  backgroundTasks: number;
  /** Messages written since the CLI last announced a turn (`system`/`init`).
   * A `result` arriving while this is non-zero may belong to an earlier
   * turn, with the message still to be read: see `onLine`. */
  messagesSinceInit: number;
  settleTimer?: NodeJS.Timeout;
  stopReason?: StopReason;
  failure?: string;
  /** Codex only: the turn in flight on the agent's thread. */
  codexTurnId?: string;
  /** Codex only: an interrupt arrived before the turn had an id to name;
   * sent as soon as it has one. */
  codexInterruptPending?: boolean;
  /** Codex only: the id of the last turn whose `turn/completed` was read. */
  lastCodexTurnCompleted?: string;
  /** How many times the agent was stopped. A message waiting in the agent's
   * queue compares it with the count when it arrived: one stopped since
   * then is not sent (the stop came after it, and wins). */
  stops?: number;
  /** The sweep of what a crashed process left behind; a new process for
   * this agent must not start before it ends (it matches by agent id). */
  pendingSweep?: Promise<unknown>;
  /** Serializes process starts and stops for this agent. */
  queue: Promise<unknown>;
}

// Shutdown budget: drain grace + interrupt grace + stop grace (agents stop
// in parallel) must stay under the unit's TimeoutStopSec, which must stay
// under the user manager's own ~90 s — unitTimeouts.io.test.ts holds them
// together. Exceeding it is safe (agents come back `host_restart`), just
// avoidable.
export const DEFAULT_STOP_GRACE_MS = 5000;

/** Longest a shutdown with default settings can take: waiting for turns,
 * waiting after interrupting them, then ending every agent's process (in
 * parallel) along its slowest path. */
export function worstCaseShutdownMs(drainGraceMs = DEFAULT_DRAIN_GRACE_MS, stopGraceMs = DEFAULT_STOP_GRACE_MS): number {
  return drainGraceMs + DRAIN_INTERRUPT_GRACE_MS + worstCaseEndMs(stopGraceMs);
}
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_MEMORY_FRACTION = 0.6;
const DEFAULT_POLICY_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ALIVE_PER_ROOM = 10;
export const DEFAULT_DRAIN_GRACE_MS = 40_000;
/** After interrupting during a drain, how long to wait for the turns to end. */
export const DRAIN_INTERRUPT_GRACE_MS = 10_000;
const DEFAULT_TURN_SETTLE_MS = 2000;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseRoomSpec(raw: unknown): HostRoomSpec | undefined {
  if (raw === undefined) return undefined;
  const bad = (why: string): never => {
    throw new HostError("bad_spec", `spec.room ${why}`);
  };
  if (typeof raw !== "object" || raw === null) return bad("must be an object");
  const room = raw as Record<string, unknown>;
  if (room.role !== "principal" && room.role !== "worker") return bad("role must be principal or worker");
  if (typeof room.instructions !== "string") return bad("instructions must be a string");
  // The room's endpoint is the relay's own, on this machine: the host never
  // forwards an agent's tool call anywhere else.
  if (typeof room.bridgeUrl !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(room.bridgeUrl)) return bad("bridgeUrl must be a loopback http URL");
  if (!Array.isArray(room.tools)) return bad("tools must be a list");
  const tools = room.tools.map((tool: unknown) => {
    const entry = tool as Record<string, unknown> | null;
    if (!entry || typeof entry.name !== "string" || typeof entry.description !== "string" || typeof entry.inputSchema !== "object" || entry.inputSchema === null) {
      return bad("tools must have a name, a description and an inputSchema");
    }
    return { name: entry.name, description: entry.description, inputSchema: entry.inputSchema as Record<string, unknown> };
  });
  return { role: room.role, instructions: room.instructions, tools, bridgeUrl: room.bridgeUrl };
}

/** How long the host waits for the relay to answer a room tool call. Every
 * room tool answers at once; this only bounds a relay that is down. */
const ROOM_TOOL_TIMEOUT_MS = 30_000;

function parseSpec(raw: unknown): ClaudeAgentSpec {
  if (typeof raw !== "object" || raw === null) throw new HostError("bad_spec", "spec must be an object");
  const spec = raw as Record<string, unknown>;
  const cwd = str(spec.cwd);
  if (!cwd || !cwd.startsWith("/")) throw new HostError("bad_spec", "spec.cwd must be an absolute path");
  let env: Record<string, string> | undefined;
  if (spec.env !== undefined) {
    if (typeof spec.env !== "object" || spec.env === null) throw new HostError("bad_spec", "spec.env must be an object");
    env = {};
    for (const [key, value] of Object.entries(spec.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") throw new HostError("bad_spec", `bad env entry ${key}`);
      env[key] = value;
    }
  }
  return {
    cwd,
    model: str(spec.model),
    effort: str(spec.effort),
    permissionMode: str(spec.permissionMode),
    appendSystemPrompt: str(spec.appendSystemPrompt),
    allowedTools: str(spec.allowedTools),
    disallowedTools: str(spec.disallowedTools),
    // `""` is meaningful here (no built-in tool at all), unlike the others.
    tools: typeof spec.tools === "string" ? spec.tools : undefined,
    strictMcp: spec.strictMcp === true,
    addDirs: Array.isArray(spec.addDirs) ? spec.addDirs.filter((dir): dir is string => typeof dir === "string" && dir.startsWith("/")) : undefined,
    permissionPromptTool: str(spec.permissionPromptTool),
    mcpConfigJson: str(spec.mcpConfigJson),
    agentWorker: spec.agentWorker !== false,
    partialMessages: spec.partialMessages !== false,
    env,
    room: parseRoomSpec(spec.room),
  };
}

/** Refuses a data directory that is not this host's to use: one marked by
 * another host, or one holding files a host does not write (someone's own
 * directory, given by mistake) — the host would later mark it as its own,
 * and deleting the profile would then remove it. */
function claimDataDir(dir: string, hostId: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let owner: string | undefined;
  try {
    owner = readFileSync(join(dir, AGENT_HOST_DIR_MARKER), "utf8").trim();
  } catch {
    owner = undefined;
  }
  if (owner !== undefined && owner !== hostId) throw new Error(`${dir} belongs to the agent host "${owner}", not "${hostId}"`);
  if (owner === undefined) {
    const strangers = readdirSync(dir).filter((name) => !isAgentHostDirEntry(name));
    if (strangers.length > 0) throw new Error(`${dir} is not an agent host's data directory (it holds ${strangers.slice(0, 3).join(", ")}); give the host an empty or new directory`);
  }
}

export class AgentHost {
  private readonly agents = new Map<string, Agent>();
  private server!: AgentHostSocketServer;
  private readonly registry: AgentRegistry;
  private readonly bin: string;
  private readonly stopGraceMs: number;
  private readonly maxAlivePerRoom: number;
  private readonly now: () => number;
  private policyTimer: NodeJS.Timeout | undefined;
  private codexPool: CodexPool | undefined;
  private lock: InstanceLock | undefined;
  /** Agents being hibernated to make room in their room; not counted as
   * live, and never picked twice. */
  private readonly roomVictims = new Set<Agent>();
  /** Ids whose agent is gone from `agents` but whose log is still being
   * deleted: reusing one before that finishes would reopen the old log
   * directory and have it deleted from under the new agent. */
  private readonly removing = new Map<string, Promise<void>>();
  /** This run of the host, carried in every agent's mark. */
  private readonly incarnation = randomBytes(4).toString("hex");
  private policyRunning = false;
  private draining = false;
  private closed = false;
  /** Resolved whenever a turn ends or a process exits — what a drain waits on. */
  private turnWaiters: (() => void)[] = [];

  private constructor(private readonly options: AgentHostOptions) {
    this.bin = options.agentBin ?? AGENT_BIN;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.maxAlivePerRoom = options.maxAlivePerRoom ?? DEFAULT_MAX_ALIVE_PER_ROOM;
    this.now = options.now ?? Date.now;
    this.registry = new AgentRegistry(options.dataDir);
  }

  /** Takes the profile's lock, ends what a previous run of this host left
   * behind, restores its agents (none running), then starts serving. The
   * lock comes first: a second host for the same profile must fail before
   * its sweep or its restore could touch the first one's agents. */
  static async start(options: AgentHostOptions): Promise<AgentHost> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.hostId)) throw new Error(`invalid agent host id ${JSON.stringify(options.hostId)}`);
    const host = new AgentHost(options);
    claimDataDir(options.dataDir, options.hostId);
    mkdirSync(join(options.dataDir, "logs"), { recursive: true, mode: 0o700 });
    host.lock = await acquireInstanceLock(
      [`host-id:${options.hostId}`, `data-dir:${realpathSync(options.dataDir)}`, `socket:${resolve(options.socketPath)}`],
      options.dataDir,
    );
    try {
      writeFileSync(join(options.dataDir, AGENT_HOST_DIR_MARKER), `${options.hostId}\n`, { mode: 0o600 });
      const orphans = await sweepAgentProcesses(options.hostId, undefined, 2000);
      if (orphans > 0) console.log(`[agent-host] ended ${orphans} process(es) left behind by a previous run`);
      host.restore();
      host.server = await AgentHostSocketServer.listen({
        socketPath: options.socketPath,
        hostId: options.hostId,
        logFor: (agentId) => host.agents.get(agentId)?.log,
        handleRequest: (method, params) => host.handle(method, params),
      });
    } catch (error) {
      for (const agent of host.agents.values()) agent.log.close();
      await host.lock.release();
      throw error;
    }
    const hibernation = options.hibernation;
    if (hibernation && hibernation.policy !== "off") {
      host.policyTimer = setInterval(() => void host.runHibernationPolicy(), hibernation.intervalMs ?? DEFAULT_POLICY_INTERVAL_MS);
      host.policyTimer.unref();
    }
    return host;
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  private restore(): void {
    for (const saved of this.registry.load()) {
      if (!isValidAgentId(saved.agentId)) continue;
      const wasRunning = saved.lifecycle === "alive" || saved.lifecycle === "starting";
      const opened = this.openLogForRestore(saved.agentId);
      if (!opened) continue;
      const agent: Agent = {
        agentId: saved.agentId,
        runtime: saved.runtime,
        roomId: saved.roomId,
        owner: saved.owner,
        spec: saved.spec,
        createdAt: saved.createdAt,
        log: opened.log,
        sessionId: saved.sessionId,
        lifecycle: opened.error ? "failed" : wasRunning ? "stopped" : saved.lifecycle,
        turnInFlight: false,
        lastTurnEndedAt: saved.lastTurnEndedAt,
        lastActivityAt: saved.lastActivityAt,
        awaitingUser: saved.awaitingUser,
        backgroundTasks: 0,
        messagesSinceInit: 0,
        stopReason: wasRunning ? "host_restart" : saved.stopReason,
        failure: opened.error ? `log_error: ${opened.error}` : saved.failure,
        queue: Promise.resolve(),
      };
      this.agents.set(agent.agentId, agent);
      if (wasRunning) this.record(agent, { type: "host_process", subtype: "lost" });
    }
    this.persist();
  }

  /** An agent's log for `restore`. A log that cannot be opened must not stop
   * the host from starting: it is moved aside (kept for inspection) and the
   * agent comes back `failed` on a fresh log. `undefined` (agent skipped)
   * only if even that fails. */
  private openLogForRestore(agentId: string): { log: AgentEventLog; error?: string } | undefined {
    const dir = join(this.options.dataDir, "logs", agentId);
    try {
      return { log: AgentEventLog.open(dir, this.options.log) };
    } catch (error) {
      const message = (error as Error).message;
      console.error(`[agent-host] the log of ${agentId} could not be opened (${message}); moving it aside`);
      try {
        renameSync(dir, `${dir}.broken-${Date.now()}`);
        return { log: AgentEventLog.open(dir, this.options.log), error: message };
      } catch (second) {
        console.error(`[agent-host] giving up on restoring ${agentId}:`, (second as Error).message);
        return undefined;
      }
    }
  }

  private persist(): void {
    const agents: PersistedAgent[] = [...this.agents.values()].map((agent) => ({
      agentId: agent.agentId,
      runtime: agent.runtime,
      roomId: agent.roomId,
      owner: agent.owner,
      spec: agent.spec,
      createdAt: agent.createdAt,
      sessionId: agent.sessionId,
      lifecycle: agent.lifecycle,
      awaitingUser: agent.awaitingUser,
      lastActivityAt: agent.lastActivityAt,
      lastTurnEndedAt: agent.lastTurnEndedAt,
      stopReason: agent.stopReason,
      failure: agent.failure,
    }));
    try {
      this.registry.save(agents);
    } catch (error) {
      console.error("[agent-host] could not save the registry:", (error as Error).message);
    }
  }

  // ------------------------------------------------------------ requests

  private handle(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closed) return Promise.reject(new HostError("shutting_down", "the agent host is shutting down"));
    switch (method) {
      case "spawn":
        this.refuseWhileDraining();
        return this.spawnAgent(params);
      case "send":
        this.refuseWhileDraining();
        return this.send(this.agentParam(params), str(params.message) ?? "");
      case "interrupt":
        return Promise.resolve(this.interrupt(this.agentParam(params)));
      case "stop_task":
        return Promise.resolve(this.stopTask(this.agentParam(params), params.taskId));
      case "stop":
        return this.stop(this.agentParam(params));
      case "remove":
        return this.remove(this.agentParam(params));
      case "hibernate":
        return this.hibernate(this.agentParam(params));
      case "mark_awaiting":
        return Promise.resolve(this.markAwaiting(this.agentParam(params), params.awaiting === true));
      case "activity":
        return Promise.resolve({ agents: this.activity() });
      default:
        return Promise.reject(new HostError("unknown_method", `unknown method ${method}`));
    }
  }

  private refuseRemoved(agent: Agent): void {
    if (agent.removed) throw new HostError("unknown_agent", `no agent ${agent.agentId}`);
  }

  private refuseBrokenLog(agent: Agent): void {
    if (agent.logError) throw new HostError("log_error", `agent ${agent.agentId} cannot run: its log failed (${agent.logError})`);
  }

  /** Refuses a message that arrived before a stop that has happened since. */
  private refuseStoppedSince(agent: Agent, stops: number): void {
    if ((agent.stops ?? 0) !== stops) throw new HostError("stopped", `agent ${agent.agentId} was stopped after this message arrived; it was not sent`);
  }

  private refuseWhileDraining(): void {
    if (this.draining) throw new HostError("draining", "the agent host is shutting down");
  }

  private agentParam(params: Readonly<Record<string, unknown>>): Agent {
    if (!isValidAgentId(params.agentId)) throw new HostError("bad_agent_id", "agentId is missing or invalid");
    const agent = this.agents.get(params.agentId);
    if (!agent) throw new HostError("unknown_agent", `no agent ${params.agentId}`);
    return agent;
  }

  private async spawnAgent(params: Readonly<Record<string, unknown>>): Promise<AgentActivity> {
    const agentId = params.agentId;
    if (!isValidAgentId(agentId)) throw new HostError("bad_agent_id", "agentId is missing or invalid");
    if (this.agents.has(agentId)) throw new HostError("agent_exists", `agent ${agentId} already exists`);
    if (this.removing.has(agentId)) throw new HostError("agent_removing", `agent ${agentId} is still being removed`);
    const runtime = params.runtime ?? "claude";
    if (runtime !== "claude" && runtime !== "codex") throw new HostError("unsupported_runtime", `runtime ${JSON.stringify(runtime)} is not supported`);
    const spec = parseSpec(params.spec);
    const now = this.now();
    const agent: Agent = {
      agentId,
      runtime,
      roomId: str(params.roomId),
      owner: str(params.owner),
      spec,
      createdAt: now,
      log: AgentEventLog.open(join(this.options.dataDir, "logs", agentId), this.options.log),
      // A session the relay already has (this host lost the agent, or never
      // ran it): the first process resumes it instead of starting over.
      sessionId: str(params.sessionId),
      lifecycle: "starting",
      turnInFlight: false,
      lastActivityAt: now,
      awaitingUser: false,
      backgroundTasks: 0,
      messagesSinceInit: 0,
      queue: Promise.resolve(),
    };
    this.agents.set(agentId, agent);
    try {
      await this.serialize(agent, async () => {
        if (runtime !== "codex") return this.startProcess(agent);
        // An existing thread needs no `thread/start`: its next turn resumes it.
        if (agent.sessionId) {
          agent.lifecycle = "hibernated";
          this.touch(agent);
          this.persist();
          return;
        }
        return this.startCodexThread(agent);
      });
    } catch (error) {
      await this.forget(agent);
      throw error;
    }
    const message = str(params.message);
    if (message) {
      // Stopped while it was starting: the message it came with is not sent.
      this.refuseStoppedSince(agent, 0);
      if (runtime === "codex") await this.sendCodex(agent, message, 0);
      else this.write(agent, message);
    }
    return this.describe(agent);
  }

  private async send(agent: Agent, text: string): Promise<{ duringTurn: boolean; resumed: boolean }> {
    if (!text) throw new HostError("empty_message", "message is empty");
    this.refuseBrokenLog(agent);
    const stops = agent.stops ?? 0;
    if (agent.runtime === "codex") return this.sendCodex(agent, text, stops);
    let resumed = false;
    await this.serialize(agent, async () => {
      this.refuseRemoved(agent);
      this.refuseStoppedSince(agent, stops);
      if (!agent.proc || agent.proc.hasExited) {
        resumed = agent.sessionId !== undefined;
        await this.startProcess(agent);
      }
    });
    this.refuseStoppedSince(agent, stops);
    return { duringTurn: this.write(agent, text), resumed };
  }

  /** Writes a user message; returns whether a turn was already in flight
   * (the CLI then folds it into that turn instead of starting a new one). */
  private write(agent: Agent, text: string): boolean {
    this.refuseRemoved(agent);
    this.refuseWhileDraining();
    const proc = agent.proc;
    if (!proc) throw new HostError("not_running", `agent ${agent.agentId} has no process`);
    const duringTurn = agent.turnInFlight;
    this.record(agent, { type: "host_user_message", text, duringTurn });
    proc.writeUserMessage(text);
    agent.messagesSinceInit++;
    const wasAwaiting = agent.awaitingUser;
    agent.awaitingUser = false;
    if (!duringTurn) {
      agent.turnInFlight = true;
      agent.turnStartedAt = this.now();
    }
    this.touch(agent);
    if (wasAwaiting) this.persist();
    return duringTurn;
  }

  private interrupt(agent: Agent): { interrupted: boolean } {
    if (agent.runtime === "codex") {
      if (!agent.turnInFlight || !agent.sessionId) return { interrupted: false };
      this.record(agent, { type: "host_interrupt" });
      if (!agent.codexTurnId) {
        // The turn is starting (its `turn/start` not answered yet): it is
        // interrupted the moment it has an id.
        agent.codexInterruptPending = true;
        return { interrupted: true };
      }
      this.interruptCodexTurn(agent);
      return { interrupted: true };
    }
    if (!agent.proc || agent.proc.hasExited || !agent.turnInFlight) return { interrupted: false };
    this.record(agent, { type: "host_interrupt" });
    agent.proc.writeInterrupt();
    return { interrupted: true };
  }

  /** Stops one native subagent of a Claude agent (the CLI's `stop_task`):
   * the agent, its turn and its other subagents go on. */
  private stopTask(agent: Agent, taskId: unknown): { sent: true } {
    if (typeof taskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new HostError("bad_request", "taskId is missing or invalid");
    if (agent.runtime !== "claude") throw new HostError("unsupported", "only a Claude agent has native subagents to stop");
    if (!agent.proc || agent.proc.hasExited) throw new HostError("not_running", `agent ${agent.agentId} has no process`);
    this.record(agent, { type: "host_stop_task", taskId });
    agent.proc.writeStopTask(taskId);
    return { sent: true };
  }

  private interruptCodexTurn(agent: Agent): void {
    agent.codexInterruptPending = false;
    if (!agent.sessionId || !agent.codexTurnId) return;
    void this.codex()
      .interrupt(agent.sessionId, agent.codexTurnId)
      .catch((error: unknown) => console.error(`[agent-host] interrupting ${agent.agentId} failed:`, (error as Error).message));
  }

  private async stop(agent: Agent): Promise<AgentActivity> {
    agent.stops = (agent.stops ?? 0) + 1;
    if (agent.runtime === "codex") this.interrupt(agent);
    await this.serialize(agent, async () => {
      if (agent.proc && !agent.proc.hasExited) await this.endProcess(agent, "stop");
      agent.lifecycle = "stopped";
      agent.stopReason = "user";
      this.touch(agent);
      this.persist();
    });
    return this.describe(agent);
  }

  private async remove(agent: Agent): Promise<{ removed: true }> {
    this.refuseRemoved(agent);
    agent.removed = true;
    if (agent.runtime === "codex") this.interrupt(agent);
    await this.serialize(agent, async () => {
      if (agent.proc && !agent.proc.hasExited) await this.endProcess(agent, "remove");
    });
    this.server.closeSubscriptions(agent.agentId, "removed");
    await this.forget(agent);
    return { removed: true };
  }

  /** Drops an agent and deletes its log, keeping its id reserved until the
   * deletion is done. Idempotent per id: a remove and a failing spawn can
   * both get here for one agent, and must share one deletion — otherwise
   * the first to finish would release the id while the other still
   * deletes. */
  private forget(agent: Agent): Promise<void> {
    const pending = this.removing.get(agent.agentId);
    if (pending) return pending;
    const done: Promise<void> = (async () => {
      this.agents.delete(agent.agentId);
      this.persist();
      await agent.log.destroy();
    })().finally(() => {
      if (this.removing.get(agent.agentId) === done) this.removing.delete(agent.agentId);
    });
    this.removing.set(agent.agentId, done);
    return done;
  }

  private hibernatable(agent: Agent): boolean {
    // A Codex agent has no process of its own: idle (no turn, and so no
    // approval or question pending — those are answered at once), it only
    // gives up its room slot; its thread stays in the app-server.
    if (agent.runtime === "codex") return agent.lifecycle === "alive" && !agent.turnInFlight;
    return agent.lifecycle === "alive" && agent.proc !== undefined && !agent.proc.hasExited && !agent.turnInFlight && agent.backgroundTasks === 0;
  }

  private async hibernate(agent: Agent): Promise<AgentActivity> {
    await this.serialize(agent, async () => {
      if (agent.lifecycle === "hibernated") return;
      if (!this.hibernatable(agent)) {
        const why = agent.turnInFlight
          ? "a turn is in flight"
          : agent.backgroundTasks > 0
            ? "background tasks are still running"
            : `the agent is ${this.stateOf(agent)}`;
        throw new HostError("not_hibernatable", `cannot hibernate ${agent.agentId}: ${why}`);
      }
      if (agent.runtime === "codex") {
        agent.lifecycle = "hibernated";
        this.touch(agent);
        this.persist();
        return;
      }
      const detached = await this.detachedJobs(agent);
      // The process may have exited (or a turn started) during that await:
      // ending it now would label a crash an expected hibernation.
      if (!this.hibernatable(agent)) throw new HostError("not_hibernatable", `cannot hibernate ${agent.agentId}: it changed state`);
      if (detached > 0) this.record(agent, { type: "host_process", subtype: "killed_detached", count: detached });
      await this.endProcess(agent, "hibernate");
    });
    return this.describe(agent);
  }

  private markAwaiting(agent: Agent, awaiting: boolean): AgentActivity {
    if (agent.awaitingUser !== awaiting) {
      agent.awaitingUser = awaiting;
      this.touch(agent);
      this.persist();
    }
    return this.describe(agent);
  }

  // ------------------------------------------------------------ hibernation policy

  /** One pass of the configured policy. Public so a test can run it at a
   * moment of its choosing (with an injected clock) instead of waiting. */
  async runHibernationPolicy(): Promise<string[]> {
    const policy = this.options.hibernation;
    if (!policy || policy.policy === "off" || this.policyRunning || this.draining) return [];
    this.policyRunning = true;
    try {
      const candidates = [...this.agents.values()].filter((agent) => this.hibernatable(agent)).sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      const chosen: Agent[] = [];
      if (policy.policy === "idle") {
        const idleMs = policy.idleMs ?? DEFAULT_IDLE_MS;
        const now = this.now();
        for (const agent of candidates) {
          if (now - agent.lastActivityAt < idleMs) continue;
          // Being idle is no reason to end a job the agent started to keep
          // running (a dev server): only memory pressure, an explicit
          // hibernate or a stop does that.
          if ((await this.detachedJobs(agent)) > 0) continue;
          chosen.push(agent);
        }
      } else {
        const budget = (policy.memoryBytes ?? 0) * (policy.memoryFraction ?? DEFAULT_MEMORY_FRACTION);
        const byAgent = await agentProcessMap(this.options.hostId);
        const usage = new Map<string, number>();
        let total = 0;
        for (const [agentId, pids] of byAgent) {
          const bytes = await pssBytes(pids);
          usage.set(agentId, bytes);
          total += bytes;
        }
        for (const agent of candidates) {
          if (total <= budget) break;
          // Hibernating an agent with no memory of its own (a Codex agent:
          // its process is shared) frees nothing; the room cap still applies.
          const used = usage.get(agent.agentId) ?? 0;
          if (used <= 0) continue;
          chosen.push(agent);
          total -= used;
        }
      }
      const hibernated: string[] = [];
      for (const agent of chosen) {
        try {
          await this.hibernate(agent);
          hibernated.push(agent.agentId);
        } catch {
          // became busy meanwhile
        }
      }
      return hibernated;
    } finally {
      this.policyRunning = false;
    }
  }

  private async detachedJobs(agent: Agent): Promise<number> {
    const pid = agent.proc?.pid;
    if (pid === undefined || pid <= 0) return 0;
    return (await detachedAgentProcesses(this.options.hostId, agent.agentId, pid)).length;
  }

  /**
   * Claims a live slot in the agent's room before its process (or Codex
   * turn) starts: marks the agent `starting` synchronously, before any
   * await, so concurrent starts in the same room count each other. In a
   * full room it makes room by hibernating the oldest idle agents — chosen
   * under the same exclusion, so two starts never pick the same one — and
   * fails when there are not enough idle agents.
   */
  private async makeRoomFor(agent: Agent): Promise<void> {
    const previous = agent.lifecycle;
    if (agent.roomId === undefined) {
      agent.lifecycle = "starting";
      return;
    }
    const live = [...this.agents.values()].filter(
      (other) =>
        other !== agent && other.roomId === agent.roomId && (other.lifecycle === "alive" || other.lifecycle === "starting") && !this.roomVictims.has(other),
    );
    if (live.length < this.maxAlivePerRoom) {
      agent.lifecycle = "starting";
      return;
    }
    const needed = live.length - this.maxAlivePerRoom + 1;
    const idle = live.filter((other) => this.hibernatable(other)).sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    if (idle.length < needed) {
      throw new HostError("room_cap_reached", `room ${agent.roomId} already has ${live.length} live agents (limit ${this.maxAlivePerRoom}) and none is idle`);
    }
    const victims = idle.slice(0, needed);
    for (const victim of victims) this.roomVictims.add(victim);
    agent.lifecycle = "starting";
    try {
      for (const victim of victims) await this.hibernate(victim);
    } catch {
      agent.lifecycle = previous;
      throw new HostError("room_cap_reached", `room ${agent.roomId} is full and an idle agent could not be hibernated to make room`);
    } finally {
      for (const victim of victims) this.roomVictims.delete(victim);
    }
  }

  // ------------------------------------------------------------ codex (skeleton, see codexPool.ts)

  private codex(): CodexPool {
    this.codexPool ??= new CodexPool({
      hostId: this.options.hostId,
      incarnation: this.incarnation,
      homeOverride: this.options.homeOverride,
      def: this.options.codexDef,
      cwd: this.options.dataDir,
      onNotification: (threadId, method, params) => this.onCodexNotification(threadId, method, params),
      onServerRequest: (_threadId, kind, detail) => this.onCodexServerRequest(kind, detail),
      onExit: (reason) => this.onCodexExit(reason),
      onRoomToolCall: (call) => this.onRoomToolCall(call),
    });
    return this.codexPool;
  }

  /** A room tool a Codex agent called: forwarded to the relay's room
   * endpoint for that agent, the same one a Claude agent calls over MCP.
   * Never throws: any failure is an answer the model can read. */
  private async onRoomToolCall(call: RoomToolCall): Promise<{ text: string; isError: boolean }> {
    const agent = this.codexAgentFor(call.threadId);
    const room = agent?.spec.room;
    if (!agent || !room) return { text: "The room tools are not available to this agent.", isError: true };
    try {
      const response = await fetch(room.bridgeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: call.tool, arguments: call.arguments ?? {} } }),
        signal: AbortSignal.timeout(ROOM_TOOL_TIMEOUT_MS),
      });
      if (!response.ok) return { text: `The room refused the call (HTTP ${response.status}); this agent may no longer be part of a room.`, isError: true };
      const body = (await response.json()) as { result?: { content?: { text?: unknown }[]; isError?: unknown } };
      const text = (body.result?.content ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join("");
      return { text, isError: body.result?.isError === true };
    } catch (error) {
      return { text: `The room did not answer (${(error as Error).message}); the relay may be restarting, try again.`, isError: true };
    }
  }

  private codexContext(agent: Agent, prompt: string): TurnContext {
    return {
      cwd: agent.spec.cwd,
      prompt,
      modelId: agent.spec.model,
      effortId: agent.spec.effort,
      permissionModeId: agent.spec.permissionMode ?? this.codex().defaultPermissionModeId,
      resumeSessionId: agent.sessionId,
      ...(agent.spec.room
        ? {
            room: {
              role: agent.spec.room.role,
              instructions: agent.spec.room.instructions,
              tools: agent.spec.room.tools,
              ...(agent.spec.room.role === "principal" ? { disableMcpServers: userCodexMcpServers(this.options.homeOverride ?? homedir()) } : {}),
            },
          }
        : {}),
    };
  }

  private async startCodexThread(agent: Agent): Promise<void> {
    await this.makeRoomFor(agent);
    try {
      agent.sessionId = await this.codex().startThread(this.codexContext(agent, ""));
    } catch (error) {
      throw new HostError("spawn_failed", `could not start a Codex thread: ${(error as Error).message}`);
    }
    agent.lifecycle = "alive";
    this.touch(agent);
    this.persist();
  }

  private async sendCodex(agent: Agent, text: string, stops: number): Promise<{ duringTurn: boolean; resumed: boolean }> {
    // Checked and claimed inside the agent's queue: two messages racing
    // between turns must not both pass the check and start two turns on one
    // thread.
    return this.serialize(agent, async () => {
      this.refuseRemoved(agent);
      this.refuseStoppedSince(agent, stops);
      if (agent.turnInFlight) throw new HostError("turn_in_flight", "a Codex agent takes a new message only between turns");
      const resumed = agent.lifecycle !== "alive" && agent.sessionId !== undefined;
      if (!agent.sessionId) await this.startCodexThread(agent);
      else if (agent.lifecycle !== "alive") await this.makeRoomFor(agent);
      this.refuseRemoved(agent);
      this.refuseStoppedSince(agent, stops);
      this.record(agent, { type: "host_user_message", text, duringTurn: false });
      agent.awaitingUser = false;
      agent.turnInFlight = true;
      agent.codexInterruptPending = false;
      agent.turnStartedAt = this.now();
      agent.lifecycle = "alive";
      agent.stopReason = undefined;
      agent.failure = undefined;
      this.touch(agent);
      try {
        const turnId = await this.codex().startTurn(this.codexContext(agent, text), agent.sessionId!);
        // A quick turn can be over (its `turn/completed` read) before this
        // answer is: its id must not linger as the turn in flight, or a later
        // Stop would name it instead of the next turn.
        if (agent.turnInFlight && agent.lastCodexTurnCompleted !== turnId) agent.codexTurnId = turnId;
        if (agent.codexInterruptPending && agent.turnInFlight) this.interruptCodexTurn(agent);
      } catch (error) {
        agent.turnInFlight = false;
        agent.lifecycle = "failed";
        agent.failure = `Codex refused the turn: ${(error as Error).message}`;
        this.touch(agent);
        this.persist();
        throw new HostError("turn_failed", agent.failure);
      }
      this.persist();
      return { duringTurn: false, resumed };
    });
  }

  private codexAgentFor(threadId: string | undefined): Agent | undefined {
    if (threadId === undefined) return undefined;
    for (const agent of this.agents.values()) if (agent.runtime === "codex" && agent.sessionId === threadId) return agent;
    return undefined;
  }

  private onCodexNotification(threadId: string | undefined, method: string, params: unknown): void {
    const agent = this.codexAgentFor(threadId);
    if (!agent) {
      if (method === CODEX_RATE_LIMITS_UPDATED_METHOD) this.onCodexAccountLimits(method, params);
      return;
    }
    if (!this.appendTo(agent, { type: "codex_notification", method, params })) return;
    const before = this.stateOf(agent);
    if (method === "turn/started") {
      agent.turnInFlight = true;
      const id = (params as { turn?: { id?: unknown } }).turn?.id;
      if (typeof id === "string") agent.codexTurnId = id;
      if (agent.codexInterruptPending) this.interruptCodexTurn(agent);
    } else if (method === "turn/completed") {
      const id = (params as { turn?: { id?: unknown } }).turn?.id;
      if (typeof id === "string") agent.lastCodexTurnCompleted = id;
      agent.turnInFlight = false;
      agent.codexTurnId = undefined;
      agent.lastTurnEndedAt = this.now();
      this.notifyTurnWaiters();
    }
    agent.lastActivityAt = this.now();
    if (this.stateOf(agent) !== before) this.broadcast(agent);
  }

  /** The account's new rate limits, pushed with no thread attached: the
   * limits are account-wide, so they are recorded on one Codex agent with a
   * turn in flight, whose relay reads them off the log for its plan usage.
   * With none in a turn, nobody is reading, and the push is dropped. */
  private onCodexAccountLimits(method: string, params: unknown): void {
    const agent = [...this.agents.values()].find((candidate) => candidate.runtime === "codex" && candidate.turnInFlight);
    if (agent) this.appendTo(agent, { type: "codex_notification", method, params });
  }

  /** The transport hands the host a request with no thread attached; it is
   * recorded on the one Codex agent with a turn in flight, when there is
   * exactly one. */
  private onCodexServerRequest(kind: "approval" | "user_input", detail: unknown): void {
    const inFlight = [...this.agents.values()].filter((agent) => agent.runtime === "codex" && agent.turnInFlight);
    if (inFlight.length === 1) {
      this.appendTo(inFlight[0], { type: "host_codex_request_declined", kind, detail });
    } else {
      console.error(`[agent-host] declined a Codex ${kind} request that could not be attributed to one agent`);
    }
  }

  private onCodexExit(reason: string): void {
    for (const agent of this.agents.values()) {
      if (agent.runtime !== "codex") continue;
      if (agent.lifecycle === "alive" && !agent.turnInFlight) {
        // Nothing was lost: its thread is resumed on the next app-server.
        agent.lifecycle = "hibernated";
        this.touch(agent);
        continue;
      }
      if (!agent.turnInFlight) continue;
      agent.turnInFlight = false;
      agent.codexTurnId = undefined;
      agent.lifecycle = "failed";
      agent.failure = `the Codex app-server exited (${reason})`;
      this.record(agent, { type: "host_process", subtype: "lost" });
      this.touch(agent);
    }
    this.persist();
    this.notifyTurnWaiters();
  }

  // ------------------------------------------------------------ processes

  private serialize<T>(agent: Agent, task: () => Promise<T>): Promise<T> {
    const run = agent.queue.then(task, task);
    agent.queue = run.catch(() => {});
    return run;
  }

  private async startProcess(agent: Agent): Promise<void> {
    this.refuseRemoved(agent);
    this.refuseWhileDraining();
    // A process that exited but whose pipes are still held (up to a few
    // seconds) has not been handled yet: let its exit be recorded — crash,
    // failure, sweep — before anything replaces it.
    const previous = agent.proc;
    if (previous) await previous.exited;
    if (agent.pendingSweep) await agent.pendingSweep;
    this.refuseRemoved(agent);
    await this.makeRoomFor(agent);
    this.refuseRemoved(agent);
    const resumeSessionId = agent.sessionId;
    agent.lifecycle = "starting";
    agent.failure = undefined;
    agent.stopReason = undefined;
    agent.ending = undefined;
    this.broadcast(agent);
    let proc: ClaudeProcess;
    try {
      proc = await ClaudeProcess.spawn({
        hostId: this.options.hostId,
        agentId: agent.agentId,
        incarnation: this.incarnation,
        bin: this.bin,
        homeOverride: this.options.homeOverride,
        home: this.options.homeOverride ?? homedir(),
        spec: agent.spec,
        resumeSessionId,
        stderrPath: join(agent.log.dir, "stderr.log"),
        onLine: (line) => this.onLine(agent, line),
      });
    } catch (error) {
      agent.lifecycle = "failed";
      agent.failure = `could not start the agent: ${(error as Error).message}`;
      this.touch(agent);
      this.persist();
      throw new HostError("spawn_failed", agent.failure);
    }
    agent.proc = proc;
    agent.lifecycle = "alive";
    this.record(agent, { type: "host_process", subtype: "spawned", pid: proc.pid, resumed: resumeSessionId !== undefined });
    void proc.exited.then((info) => this.onExit(agent, proc, info.code, info.signal));
    if (this.draining) {
      // The drain began while this process was starting: nothing may run
      // past it. Ended before any message reaches it.
      await this.endProcess(agent, "shutdown");
      throw new HostError("draining", "the agent host is shutting down");
    }
    this.touch(agent);
    this.persist();
  }

  /** Ends the agent's process for `reason` and waits until it is gone. */
  private async endProcess(agent: Agent, reason: NonNullable<Agent["ending"]>): Promise<void> {
    const proc = agent.proc;
    if (!proc) return;
    agent.ending = reason;
    this.record(agent, { type: "host_process", subtype: reason === "hibernate" ? "hibernating" : "stop_begin" });
    if (reason === "hibernate") {
      proc.endInput();
      await proc.finish(this.stopGraceMs);
    } else {
      const { graceful } = await proc.terminate(this.stopGraceMs);
      if (!graceful) this.record(agent, { type: "host_process", subtype: "killed" });
    }
    await proc.exited;
  }

  private onExit(agent: Agent, proc: ClaudeProcess, code: number | null, sig: NodeJS.Signals | null): void {
    if (agent.proc !== proc) return;
    const expected = agent.ending !== undefined;
    agent.proc = undefined;
    agent.turnInFlight = false;
    agent.backgroundTasks = 0;
    agent.messagesSinceInit = 0;
    if (agent.settleTimer) clearTimeout(agent.settleTimer);
    agent.settleTimer = undefined;
    const known = this.agents.get(agent.agentId) === agent;
    if (known && agent.ending !== "remove") {
      this.record(agent, { type: "host_process", subtype: "exited", code, signal: sig, expected });
    }
    switch (agent.ending) {
      case "hibernate":
        agent.lifecycle = "hibernated";
        break;
      case "stop":
        agent.lifecycle = "stopped";
        agent.stopReason = "user";
        break;
      case "shutdown":
        agent.lifecycle = "stopped";
        agent.stopReason = "host_shutdown";
        break;
      case "remove":
        break;
      case "log_error":
        agent.lifecycle = "failed";
        break;
      case undefined: {
        agent.lifecycle = "failed";
        const tail = proc.stderrTail;
        if (!agent.logError) agent.failure = `the agent process exited (code ${String(code)}, signal ${String(sig)})${tail ? `: ${tail.slice(-500)}` : ""}`;
        // Its tools may still be running; nothing will ever stop them now.
        // A resumed process waits for this (startProcess): the sweep matches
        // by agent id.
        agent.pendingSweep = sweepAgentProcesses(this.options.hostId, agent.agentId, 2000).finally(() => {
          agent.pendingSweep = undefined;
        });
        break;
      }
    }
    agent.ending = undefined;
    if (known) {
      this.touch(agent);
      this.persist();
    }
    this.notifyTurnWaiters();
  }

  private onLine(agent: Agent, line: string): void {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      event = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { type: "host_unparsed", raw: line };
    } catch {
      event = { type: "host_unparsed", raw: line };
    }
    if (!this.appendTo(agent, event)) return;
    const before = this.stateOf(agent);
    if (typeof event.session_id === "string" && event.session_id !== agent.sessionId) {
      agent.sessionId = event.session_id;
      this.persist();
    }
    switch (event.type) {
      case "result":
        if (agent.messagesSinceInit > 0) {
          // A message was written after the CLI announced the turn this
          // result ends. Folded into that turn ("steering") nothing more
          // comes; read as a turn of its own, a `system`/`init` follows
          // shortly. Until one or the other is clear the agent counts as
          // working, so a drain or hibernation cannot drop the message.
          this.settleAfterResult(agent);
        } else {
          agent.turnInFlight = false;
          agent.lastTurnEndedAt = this.now();
          this.notifyTurnWaiters();
        }
        break;
      case "assistant":
        // Output with no turn of ours in flight: the CLI started one on its
        // own (a background task finishing can produce a second `result`
        // for the same user message).
        if (!agent.turnInFlight && (event.parent_tool_use_id === null || event.parent_tool_use_id === undefined)) {
          agent.turnInFlight = true;
          agent.turnStartedAt = this.now();
        }
        break;
      case "system":
        if (event.subtype === "background_tasks_changed" && Array.isArray(event.tasks)) agent.backgroundTasks = event.tasks.length;
        if (event.subtype === "init") {
          // The CLI announces every turn it starts with `init`.
          agent.messagesSinceInit = 0;
          if (agent.settleTimer) clearTimeout(agent.settleTimer);
          agent.settleTimer = undefined;
          if (!agent.turnInFlight) {
            agent.turnInFlight = true;
            agent.turnStartedAt = this.now();
          }
        }
        break;
      default:
        break;
    }
    agent.lastActivityAt = this.now();
    if (this.stateOf(agent) !== before) this.broadcast(agent);
  }

  private settleAfterResult(agent: Agent): void {
    if (agent.settleTimer) clearTimeout(agent.settleTimer);
    agent.settleTimer = setTimeout(() => {
      agent.settleTimer = undefined;
      if (agent.messagesSinceInit === 0) return;
      agent.messagesSinceInit = 0;
      agent.turnInFlight = false;
      agent.lastTurnEndedAt = this.now();
      this.broadcast(agent);
      this.notifyTurnWaiters();
    }, this.options.turnSettleMs ?? DEFAULT_TURN_SETTLE_MS);
    agent.settleTimer.unref();
  }

  // ------------------------------------------------------------ state

  private record(agent: Agent, event: HostEvent): void {
    this.appendTo(agent, event);
  }

  /** Appends to the agent's log; a failed write (disk full, I/O error) fails
   * that agent — never the host, and never the other agents. */
  private appendTo(agent: Agent, event: Record<string, unknown>): boolean {
    if (agent.logError) return false;
    try {
      agent.log.append(event);
      return true;
    } catch (error) {
      this.onLogError(agent, error as Error);
      return false;
    }
  }

  private onLogError(agent: Agent, error: Error): void {
    if (agent.logError) return;
    agent.logError = error.message;
    console.error(`[agent-host] agent ${agent.agentId} failed: ${error.message}`);
    agent.lifecycle = "failed";
    agent.failure = `log_error: ${error.message}`;
    agent.turnInFlight = false;
    this.touch(agent);
    this.persist();
    this.notifyTurnWaiters();
    if (agent.runtime === "codex") {
      this.interrupt(agent);
      return;
    }
    void this.serialize(agent, async () => {
      if (agent.proc && !agent.proc.hasExited) await this.endProcess(agent, "log_error");
    });
  }

  private touch(agent: Agent): void {
    agent.lastActivityAt = this.now();
    this.broadcast(agent);
  }

  private broadcast(agent: Agent): void {
    this.server?.broadcast({ type: "agent_state", agent: this.describe(agent) });
  }

  private stateOf(agent: Agent): AgentState {
    switch (agent.lifecycle) {
      case "stopped":
      case "failed":
        return agent.lifecycle;
      case "starting":
        return agent.turnInFlight ? "working" : "starting";
      case "hibernated":
        return agent.awaitingUser ? "awaiting_user" : "hibernated";
      case "alive":
        if (agent.turnInFlight) return "working";
        return agent.awaitingUser ? "awaiting_user" : "idle";
    }
  }

  private describe(agent: Agent): AgentActivity {
    const alive =
      agent.runtime === "codex"
        ? agent.lifecycle === "alive" && (this.codexPool?.running ?? false)
        : agent.proc !== undefined && !agent.proc.hasExited;
    return {
      agentId: agent.agentId,
      runtime: agent.runtime,
      roomId: agent.roomId,
      ...(agent.owner !== undefined ? { owner: agent.owner } : {}),
      state: this.stateOf(agent),
      alive,
      pid: alive ? agent.proc?.pid : undefined,
      sessionId: agent.sessionId,
      resumable: agent.sessionId !== undefined,
      awaitingUser: agent.awaitingUser,
      backgroundTasks: agent.backgroundTasks,
      createdAt: agent.createdAt,
      lastActivityAt: agent.lastActivityAt,
      turnStartedAt: agent.turnInFlight ? agent.turnStartedAt : undefined,
      lastTurnEndedAt: agent.lastTurnEndedAt,
      stopReason: agent.lifecycle === "stopped" ? agent.stopReason : undefined,
      failure: agent.lifecycle === "failed" ? agent.failure : undefined,
      nextOffset: agent.log.endOffset,
    };
  }

  activity(): AgentActivity[] {
    return [...this.agents.values()].map((agent) => this.describe(agent));
  }

  // ------------------------------------------------------------ shutdown

  private notifyTurnWaiters(): void {
    const waiters = this.turnWaiters;
    this.turnWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolves when no agent has a turn in flight, or after `timeoutMs`. */
  private async waitForTurns(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (![...this.agents.values()].some((agent) => agent.turnInFlight)) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        new Promise<void>((resolve) => this.turnWaiters.push(resolve)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
        }),
      ]);
      clearTimeout(timer);
    }
  }

  /**
   * Graceful shutdown (see the header): waits for turns, interrupts what is
   * left, hibernates idle agents and stops the ones whose work was cut, then
   * closes the socket. Idempotent.
   */
  async close(options: { drainGraceMs?: number } = {}): Promise<void> {
    if (this.closed || this.draining) return;
    this.draining = true;
    if (this.policyTimer) clearInterval(this.policyTimer);
    const grace = options.drainGraceMs ?? this.options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
    const cut = new Set<Agent>();
    if (!(await this.waitForTurns(grace))) {
      for (const agent of this.agents.values()) {
        if (!agent.turnInFlight) continue;
        cut.add(agent);
        this.interrupt(agent);
      }
      await this.waitForTurns(this.options.drainInterruptGraceMs ?? DRAIN_INTERRUPT_GRACE_MS);
    }
    await Promise.all(
      [...this.agents.values()].map((agent) =>
        this.serialize(agent, async () => {
          if (!agent.proc || agent.proc.hasExited) return;
          // Decided here, in the agent's own queue, not before: anything
          // queued ahead of this task (a start, a write) has happened by now.
          const workCut = cut.has(agent) || agent.turnInFlight || agent.backgroundTasks > 0 || agent.messagesSinceInit > 0;
          await this.endProcess(agent, workCut ? "shutdown" : "hibernate");
        }),
      ),
    );
    for (const agent of this.agents.values()) {
      if (agent.runtime !== "codex" || agent.lifecycle !== "alive") continue;
      if (cut.has(agent) || agent.turnInFlight) {
        agent.lifecycle = "stopped";
        agent.stopReason = "host_shutdown";
      } else {
        agent.lifecycle = "hibernated";
      }
      agent.turnInFlight = false;
    }
    this.codexPool?.close();
    this.closed = true;
    this.persist();
    await this.server.close();
    for (const agent of this.agents.values()) agent.log.close();
    await this.lock?.release();
  }
}
