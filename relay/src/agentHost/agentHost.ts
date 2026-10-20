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
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_BIN } from "../runtimes/executables.js";
import { ClaudeProcess, type ClaudeAgentSpec } from "./claudeProcess.js";
import { AgentEventLog, type EventLogOptions } from "./eventLog.js";
import { agentProcessMap, pssBytes, sweepAgentProcesses } from "./processTree.js";
import { HostError, isValidAgentId, type AgentActivity, type AgentRuntimeId, type AgentState, type HostEvent, type StopReason } from "./protocol.js";
import { AgentRegistry, type PersistedAgent, type PersistedLifecycle } from "./registry.js";
import { AgentHostSocketServer } from "./socketServer.js";

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
  readonly log?: EventLogOptions;
  readonly now?: () => number;
}

interface Agent {
  readonly agentId: string;
  readonly runtime: AgentRuntimeId;
  readonly roomId?: string;
  readonly spec: ClaudeAgentSpec;
  readonly createdAt: number;
  readonly log: AgentEventLog;
  sessionId?: string;
  lifecycle: PersistedLifecycle;
  proc?: ClaudeProcess;
  /** Set while the host itself is ending the process, so its exit is not
   * mistaken for a crash. */
  ending?: "stop" | "remove" | "hibernate" | "shutdown";
  turnInFlight: boolean;
  turnStartedAt?: number;
  lastTurnEndedAt?: number;
  lastActivityAt: number;
  awaitingUser: boolean;
  backgroundTasks: number;
  stopReason?: StopReason;
  failure?: string;
  /** Serializes process starts and stops for this agent. */
  queue: Promise<unknown>;
}

const DEFAULT_STOP_GRACE_MS = 5000;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_MEMORY_FRACTION = 0.6;
const DEFAULT_POLICY_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ALIVE_PER_ROOM = 10;
const DEFAULT_DRAIN_GRACE_MS = 120_000;
/** After interrupting during a drain, how long to wait for the turns to end. */
const DRAIN_INTERRUPT_GRACE_MS = 10_000;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

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
    permissionPromptTool: str(spec.permissionPromptTool),
    mcpConfigJson: str(spec.mcpConfigJson),
    agentWorker: spec.agentWorker !== false,
    partialMessages: spec.partialMessages !== false,
    env,
  };
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

  /** Ends what a previous run of this host left behind, restores its agents
   * (none running), then starts serving. */
  static async start(options: AgentHostOptions): Promise<AgentHost> {
    const host = new AgentHost(options);
    mkdirSync(join(options.dataDir, "logs"), { recursive: true, mode: 0o700 });
    const orphans = await sweepAgentProcesses(options.hostId, undefined, 2000);
    if (orphans > 0) console.log(`[agent-host] ended ${orphans} process(es) left behind by a previous run`);
    host.restore();
    host.server = await AgentHostSocketServer.listen({
      socketPath: options.socketPath,
      hostId: options.hostId,
      logFor: (agentId) => host.agents.get(agentId)?.log,
      handleRequest: (method, params) => host.handle(method, params),
    });
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
      const agent: Agent = {
        agentId: saved.agentId,
        runtime: saved.runtime,
        roomId: saved.roomId,
        spec: saved.spec,
        createdAt: saved.createdAt,
        log: AgentEventLog.open(join(this.options.dataDir, "logs", saved.agentId), this.options.log),
        sessionId: saved.sessionId,
        lifecycle: wasRunning ? "stopped" : saved.lifecycle,
        turnInFlight: false,
        lastTurnEndedAt: saved.lastTurnEndedAt,
        lastActivityAt: saved.lastActivityAt,
        awaitingUser: saved.awaitingUser,
        backgroundTasks: 0,
        stopReason: wasRunning ? "host_restart" : saved.stopReason,
        failure: saved.failure,
        queue: Promise.resolve(),
      };
      this.agents.set(agent.agentId, agent);
      if (wasRunning) this.record(agent, { type: "host_process", subtype: "lost" });
    }
    this.persist();
  }

  private persist(): void {
    const agents: PersistedAgent[] = [...this.agents.values()].map((agent) => ({
      agentId: agent.agentId,
      runtime: agent.runtime,
      roomId: agent.roomId,
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
    const runtime = params.runtime ?? "claude";
    if (runtime !== "claude") throw new HostError("unsupported_runtime", `runtime ${JSON.stringify(runtime)} is not supported`);
    const spec = parseSpec(params.spec);
    const now = this.now();
    const agent: Agent = {
      agentId,
      runtime,
      roomId: str(params.roomId),
      spec,
      createdAt: now,
      log: AgentEventLog.open(join(this.options.dataDir, "logs", agentId), this.options.log),
      lifecycle: "starting",
      turnInFlight: false,
      lastActivityAt: now,
      awaitingUser: false,
      backgroundTasks: 0,
      queue: Promise.resolve(),
    };
    this.agents.set(agentId, agent);
    try {
      await this.serialize(agent, () => this.startProcess(agent));
    } catch (error) {
      this.agents.delete(agentId);
      await agent.log.destroy();
      this.persist();
      throw error;
    }
    const message = str(params.message);
    if (message) this.write(agent, message);
    return this.describe(agent);
  }

  private async send(agent: Agent, text: string): Promise<{ duringTurn: boolean; resumed: boolean }> {
    if (!text) throw new HostError("empty_message", "message is empty");
    let resumed = false;
    await this.serialize(agent, async () => {
      if (!agent.proc || agent.proc.hasExited) {
        resumed = agent.sessionId !== undefined;
        await this.startProcess(agent);
      }
    });
    return { duringTurn: this.write(agent, text), resumed };
  }

  /** Writes a user message; returns whether a turn was already in flight
   * (the CLI then folds it into that turn instead of starting a new one). */
  private write(agent: Agent, text: string): boolean {
    const proc = agent.proc;
    if (!proc) throw new HostError("not_running", `agent ${agent.agentId} has no process`);
    const duringTurn = agent.turnInFlight;
    this.record(agent, { type: "host_user_message", text, duringTurn });
    proc.writeUserMessage(text);
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
    if (!agent.proc || agent.proc.hasExited || !agent.turnInFlight) return { interrupted: false };
    this.record(agent, { type: "host_interrupt" });
    agent.proc.writeInterrupt();
    return { interrupted: true };
  }

  private async stop(agent: Agent): Promise<AgentActivity> {
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
    await this.serialize(agent, async () => {
      if (agent.proc && !agent.proc.hasExited) await this.endProcess(agent, "remove");
    });
    this.agents.delete(agent.agentId);
    this.server.closeSubscriptions(agent.agentId);
    await agent.log.destroy();
    this.persist();
    return { removed: true };
  }

  private hibernatable(agent: Agent): boolean {
    return agent.lifecycle === "alive" && agent.proc !== undefined && !agent.proc.hasExited && !agent.turnInFlight && agent.backgroundTasks === 0;
  }

  private async hibernate(agent: Agent): Promise<AgentActivity> {
    await this.serialize(agent, async () => {
      if (agent.lifecycle === "hibernated") return;
      if (!this.hibernatable(agent)) {
        const why = agent.turnInFlight ? "a turn is in flight" : agent.backgroundTasks > 0 ? "background tasks are still running" : `the agent is ${this.stateOf(agent)}`;
        throw new HostError("not_hibernatable", `cannot hibernate ${agent.agentId}: ${why}`);
      }
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
        chosen.push(...candidates.filter((agent) => now - agent.lastActivityAt >= idleMs));
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
          chosen.push(agent);
          total -= usage.get(agent.agentId) ?? 0;
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

  /** Before a process starts in a full room, makes room by hibernating its
   * oldest idle agent; fails when every live agent there is busy. */
  private async makeRoomFor(agent: Agent): Promise<void> {
    if (agent.roomId === undefined) return;
    const live = [...this.agents.values()].filter(
      (other) => other !== agent && other.roomId === agent.roomId && (other.lifecycle === "alive" || other.lifecycle === "starting"),
    );
    if (live.length < this.maxAlivePerRoom) return;
    const idle = live.filter((other) => this.hibernatable(other)).sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    const needed = live.length - this.maxAlivePerRoom + 1;
    if (idle.length < needed) {
      throw new HostError("room_cap_reached", `room ${agent.roomId} already has ${live.length} live agents (limit ${this.maxAlivePerRoom}) and none is idle`);
    }
    for (const other of idle.slice(0, needed)) await this.hibernate(other);
  }

  // ------------------------------------------------------------ processes

  private serialize<T>(agent: Agent, task: () => Promise<T>): Promise<T> {
    const run = agent.queue.then(task, task);
    agent.queue = run.catch(() => {});
    return run;
  }

  private async startProcess(agent: Agent): Promise<void> {
    await this.makeRoomFor(agent);
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
    this.touch(agent);
    this.persist();
    void proc.exited.then((info) => this.onExit(agent, proc, info.code, info.signal));
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
      case undefined: {
        agent.lifecycle = "failed";
        const tail = proc.stderrTail;
        agent.failure = `the agent process exited (code ${String(code)}, signal ${String(sig)})${tail ? `: ${tail.slice(-500)}` : ""}`;
        // Its tools may still be running; nothing will ever stop them now.
        // Queued with the agent's process starts: the sweep matches by agent
        // id, so it must finish before a resumed process carries that id.
        void this.serialize(agent, () => sweepAgentProcesses(this.options.hostId, agent.agentId, 2000));
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
    agent.log.append(event);
    const before = this.stateOf(agent);
    if (typeof event.session_id === "string" && event.session_id !== agent.sessionId) {
      agent.sessionId = event.session_id;
      this.persist();
    }
    switch (event.type) {
      case "result":
        agent.turnInFlight = false;
        agent.lastTurnEndedAt = this.now();
        this.notifyTurnWaiters();
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
        break;
      default:
        break;
    }
    agent.lastActivityAt = this.now();
    if (this.stateOf(agent) !== before) this.broadcast(agent);
  }

  // ------------------------------------------------------------ state

  private record(agent: Agent, event: HostEvent): void {
    agent.log.append(event);
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
    const alive = agent.proc !== undefined && !agent.proc.hasExited;
    return {
      agentId: agent.agentId,
      runtime: agent.runtime,
      roomId: agent.roomId,
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
      await this.waitForTurns(DRAIN_INTERRUPT_GRACE_MS);
    }
    for (const agent of this.agents.values()) if (agent.turnInFlight || agent.backgroundTasks > 0) cut.add(agent);
    await Promise.all(
      [...this.agents.values()].map((agent) =>
        this.serialize(agent, async () => {
          if (!agent.proc || agent.proc.hasExited) return;
          await this.endProcess(agent, cut.has(agent) ? "shutdown" : "hibernate");
        }),
      ),
    );
    this.closed = true;
    this.persist();
    await this.server.close();
    for (const agent of this.agents.values()) agent.log.close();
  }
}
