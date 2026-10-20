// The agent host: owns every agent process of one profile, records each
// agent's events in its own log, and serves both over the unix socket.
//
// The relay asks for agents by id and streams their logs; it never holds an
// agent process itself, so a relay restart leaves every agent — and any turn
// in flight — untouched.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_BIN } from "../runtimes/executables.js";
import { ClaudeProcess, type ClaudeAgentSpec } from "./claudeProcess.js";
import { AgentEventLog, type EventLogOptions } from "./eventLog.js";
import { sweepAgentProcesses } from "./processTree.js";
import { HostError, isValidAgentId, type AgentActivity, type AgentRuntimeId, type AgentState, type HostEvent, type StopReason } from "./protocol.js";
import { AgentHostSocketServer } from "./socketServer.js";

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
  readonly log?: EventLogOptions;
  readonly now?: () => number;
}

type Lifecycle = "starting" | "alive" | "hibernated" | "stopped" | "failed";

interface Agent {
  readonly agentId: string;
  readonly runtime: AgentRuntimeId;
  readonly roomId?: string;
  readonly spec: ClaudeAgentSpec;
  readonly createdAt: number;
  readonly log: AgentEventLog;
  sessionId?: string;
  lifecycle: Lifecycle;
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
  private readonly bin: string;
  private readonly stopGraceMs: number;
  private readonly now: () => number;
  private closed = false;

  private constructor(private readonly options: AgentHostOptions) {
    this.bin = options.agentBin ?? AGENT_BIN;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.now = options.now ?? Date.now;
  }

  /** Sweeps processes a previous instance of this host left behind, then
   * starts serving. */
  static async start(options: AgentHostOptions): Promise<AgentHost> {
    const host = new AgentHost(options);
    mkdirSync(join(options.dataDir, "logs"), { recursive: true, mode: 0o700 });
    const orphans = await sweepAgentProcesses(options.hostId, undefined, 2000);
    if (orphans > 0) console.log(`[agent-host] ended ${orphans} process(es) left behind by a previous run`);
    host.server = await AgentHostSocketServer.listen({
      socketPath: options.socketPath,
      hostId: options.hostId,
      logFor: (agentId) => host.agents.get(agentId)?.log,
      handleRequest: (method, params) => host.handle(method, params),
    });
    return host;
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  // ------------------------------------------------------------ requests

  private handle(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closed) return Promise.reject(new HostError("shutting_down", "the agent host is shutting down"));
    switch (method) {
      case "spawn":
        return this.spawnAgent(params);
      case "send":
        return this.send(this.agentParam(params), str(params.message) ?? "");
      case "interrupt":
        return Promise.resolve(this.interrupt(this.agentParam(params)));
      case "stop":
        return this.stop(this.agentParam(params));
      case "remove":
        return this.remove(this.agentParam(params));
      case "activity":
        return Promise.resolve({ agents: this.activity() });
      default:
        return Promise.reject(new HostError("unknown_method", `unknown method ${method}`));
    }
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
      await this.startProcess(agent);
    } catch (error) {
      this.agents.delete(agentId);
      await agent.log.destroy();
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
    agent.awaitingUser = false;
    if (!duringTurn) {
      agent.turnInFlight = true;
      agent.turnStartedAt = this.now();
    }
    this.touch(agent);
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
      if (agent.proc && !agent.proc.hasExited) {
        await this.endProcess(agent, "stop");
      }
      agent.lifecycle = "stopped";
      agent.stopReason = "user";
      this.touch(agent);
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
    return { removed: true };
  }

  // ------------------------------------------------------------ processes

  private serialize<T>(agent: Agent, task: () => Promise<T>): Promise<T> {
    const run = agent.queue.then(task, task);
    agent.queue = run.catch(() => {});
    return run;
  }

  private async startProcess(agent: Agent): Promise<void> {
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
      throw new HostError("spawn_failed", agent.failure);
    }
    agent.proc = proc;
    agent.lifecycle = "alive";
    this.record(agent, { type: "host_process", subtype: "spawned", pid: proc.pid, resumed: resumeSessionId !== undefined });
    this.touch(agent);
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
    if (this.agents.get(agent.agentId) === agent && agent.ending !== "remove") {
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
    if (this.agents.get(agent.agentId) === agent) this.touch(agent);
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
    if (typeof event.session_id === "string" && event.session_id !== agent.sessionId) agent.sessionId = event.session_id;
    switch (event.type) {
      case "result":
        agent.turnInFlight = false;
        agent.lastTurnEndedAt = this.now();
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

  /** Stops every agent process and the socket. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(
      [...this.agents.values()].map((agent) =>
        this.serialize(agent, async () => {
          if (agent.proc && !agent.proc.hasExited) await this.endProcess(agent, "shutdown");
        }),
      ),
    );
    await this.server.close();
    for (const agent of this.agents.values()) agent.log.close();
  }
}
