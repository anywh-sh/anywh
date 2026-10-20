// A session driver whose agent lives in the agent host (`docs/agent-host.md`)
// instead of in the relay: the host owns one long-lived process per agent
// (Claude) or one thread on its shared app-server (Codex), and records every
// event in a log the relay streams. A relay restart leaves the agent — and a
// turn in flight — running.
//
// The relay side of a turn: write the message (`send`, or `spawn` for an
// agent the host does not have yet), then read the agent's log from where it
// stood before, map the CLI's own events with the same mappers a direct
// session uses, and end the turn on the CLI's own end-of-turn event (a
// Claude `result`, a Codex `turn/completed`).
//
// Rooms are the only sessions driven this way for now; ordinary sessions
// still spawn their agent in the relay.
import { defaultCwd } from "../host/paths.js";
import { HostRequestError, START_OF_LOG, type AgentCursor, type FileCursorStore, type HostClient, type HostSubscription } from "../agentHost/hostClient.js";
import type { AgentActivity, EventMessage } from "../agentHost/protocol.js";
import type { AgentEvent } from "../protocol/agent-event.js";
import type { ContextUsage } from "../session/sessionStore.js";
import {
  buildClaudeHostSpec,
  extractContextUsage,
  isMainThreadEvent,
  isSessionInvalidError,
  isToolResultOnly,
  readHistoryFromTranscript,
  type ClaudeEvent,
} from "./defs/claude/index.js";
import { mapClaudeEvent } from "./streams/claudeStreamJson.js";
import { ClaudeSubtaskTracker } from "./streams/claudeSubtasks.js";
import type { ToolCallMemo } from "./streams/claudeToolMapping.js";
import type { AgentSessionDriver, DriverTurnResult, SubtaskInfo } from "./sessionDriver.js";
import type { AgentRuntimeDef, JsonRpcDaemonPlan, RoomAgentSetup, TurnContext } from "./types.js";

export interface HostAgentBinding {
  /** `undefined` when this relay has no agent host to talk to. */
  readonly client: HostClient | undefined;
  /** The agent's id in the host: the session's own id. */
  readonly agentId: string;
  readonly roomId?: string;
  /** The room wiring, read at every turn. A member of a room with none is
   * never started: it would run without its restrictions. */
  readonly setup?: () => RoomAgentSetup | undefined;
  /** Why this agent may not run now (stopped, removed, its room gone), or
   * `undefined` when it may. Asked before anything is sent to the host. */
  readonly admit?: () => string | undefined;
  /** Where the last record the relay processed of each agent's log is
   * kept, so a relay that restarts picks a turn in flight up where it left. */
  readonly cursors?: Pick<FileCursorStore, "get" | "set">;
}

export interface HostSessionDriverOptions {
  readonly homeOverride?: string;
  readonly initialSessionId?: string;
  readonly binding: HostAgentBinding;
  /** How long a turn waits for a disconnected host before failing. */
  readonly connectTimeoutMs?: number;
}

interface ResultUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ActiveTurn {
  readonly onEvent: (event: AgentEvent) => void;
  readonly resolve: (result: DriverTurnResult) => void;
  readonly reject: (error: Error) => void;
  /** Set once the log shows our message: everything before it belongs to
   * whatever the agent did earlier. */
  started: boolean;
  settled: boolean;
  stopRequested: boolean;
  readonly memos: Map<string, ToolCallMemo>;
  lastModel?: string;
  lastMainThreadUsage?: ResultUsage;
  contextUsage?: ContextUsage;
  lastAssistantText?: string;
  codexUsage?: { prefixTokens: number; contextWindowSize?: number };
  readonly modelId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The spec the host starts this agent with, per runtime. The one place in
 * this file that tells the two runtimes apart by their exec plan. */
function buildHostSpec(def: AgentRuntimeDef, ctx: TurnContext, setup: RoomAgentSetup | undefined): Record<string, unknown> {
  switch (def.exec.kind) {
    case "spawnPerTurn":
      return { ...buildClaudeHostSpec(ctx, setup) };
    case "jsonRpcDaemon":
      return {
        cwd: ctx.cwd,
        ...(ctx.modelId ? { model: ctx.modelId } : {}),
        ...(ctx.effortId ? { effort: ctx.effortId } : {}),
        permissionMode: ctx.permissionModeId,
        ...(setup ? { room: { role: setup.role, instructions: setup.instructions, tools: setup.tools, bridgeUrl: setup.bridgeUrl } } : {}),
      };
    case "custom":
      throw new Error(`the agent host cannot run "${def.identity.id}"`);
  }
}

export class HostSessionDriver implements AgentSessionDriver {
  /** The agent outlives the relay: a relay shutdown must neither wait for
   * its turn nor interrupt it. */
  readonly runsOutsideRelay = true;
  private sessionId: string | undefined;
  private subscription: HostSubscription | undefined;
  private turn: ActiveTurn | undefined;
  /** `/clear`: the host's agent still holds the old conversation, so the
   * next turn replaces it with a fresh one. */
  private resetPending = false;
  /** Set by `dispose`: the session is gone (deleted, or the relay is
   * stopping); nothing may start the agent again from here. */
  private retired = false;
  private readonly daemonPlan: JsonRpcDaemonPlan | undefined;
  /** A Claude agent's native subagents, seen on its log in and between
   * turns (a background one outlives the turn that started it). */
  private readonly subtasks = new ClaudeSubtaskTracker();

  constructor(
    private readonly def: AgentRuntimeDef,
    private readonly options: HostSessionDriverOptions,
  ) {
    this.sessionId = options.initialSessionId;
    this.daemonPlan = def.exec.kind === "jsonRpcDaemon" ? def.exec : undefined;
  }

  private get agentId(): string {
    return this.options.binding.agentId;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  resetSessionId(): void {
    this.sessionId = undefined;
    this.resetPending = true;
    // Records still arriving for the old conversation (a background subagent
    // finishing) must not hand its session id back.
    this.closeSubscription();
  }

  stop(): boolean {
    const turn = this.turn;
    const client = this.options.binding.client;
    if (!turn || turn.settled || !client) return false;
    turn.stopRequested = true;
    const endHere = (): void => turn.resolve({ stopped: true, contextUsage: turn.contextUsage, lastAssistantText: turn.lastAssistantText });
    client.request<{ interrupted?: boolean }>("interrupt", { agentId: this.agentId }).then(
      (answer) => {
        // Nothing in flight in the host and our message not seen yet: the
        // message was not delivered (or is about to be refused by
        // `deliver`), so no end of turn will come from the host.
        if (answer?.interrupted === false && !turn.started) endHere();
      },
      // The host cannot be reached: nothing would ever end this turn, so it
      // ends here, stopped (the host interrupts or restores the agent on its
      // own side; the next turn finds it as it is).
      endHere,
    );
    return true;
  }

  /** Ends the log subscription. The agent itself stays in the host: it is
   * removed only when its session is deleted, never because the relay
   * stops. */
  dispose(): void {
    this.retired = true;
    this.closeSubscription();
  }

  private closeSubscription(): void {
    this.subscription?.close();
    this.subscription = undefined;
  }

  /** Throws when the agent may not be started or written to now. */
  private checkAdmitted(): RoomAgentSetup | undefined {
    if (this.retired) throw new Error("this agent was removed; it takes no more turns");
    const refusal = this.options.binding.admit?.();
    if (refusal) throw new Error(refusal);
    const setup = this.options.binding.setup?.();
    if (this.options.binding.roomId !== undefined && !setup) {
      throw new Error("this agent has lost its room wiring; it is not started without its restrictions");
    }
    return setup;
  }

  readHistory(cwd: string): Promise<AgentEvent[]> {
    // Claude keeps the transcript on disk, under the same home the host's
    // process runs with; a Codex thread's history lives in the host's
    // app-server, which this driver does not query.
    if (this.daemonPlan || !this.sessionId) return Promise.resolve([]);
    const entries = readHistoryFromTranscript(defaultCwd(this.options.homeOverride), cwd, this.sessionId);
    return Promise.resolve(entries.map((entry) => entry.event));
  }

  async sendTurn(ctx: TurnContext, onEvent: (event: AgentEvent) => void): Promise<DriverTurnResult> {
    const client = this.options.binding.client;
    if (!client) throw new Error("this room's agents run in the agent host, and this relay has none: set ANYWH_PROFILE (or ANYWH_AGENT_HOST_SOCKET) and start anywh-agent-host");
    const setup = this.checkAdmitted();
    const turnCtx: TurnContext = setup ? { ...ctx, room: { role: setup.role, instructions: setup.instructions, tools: setup.tools } } : ctx;
    const spec = buildHostSpec(this.def, turnCtx, setup);

    let resolveTurn!: (result: DriverTurnResult) => void;
    let rejectTurn!: (error: Error) => void;
    const done = new Promise<DriverTurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const turn: ActiveTurn = {
      onEvent,
      resolve: (result) => {
        if (turn.settled) return;
        turn.settled = true;
        resolveTurn(result);
      },
      reject: (error) => {
        if (turn.settled) return;
        turn.settled = true;
        rejectTurn(error);
      },
      started: false,
      settled: false,
      stopRequested: false,
      memos: new Map(),
      modelId: ctx.modelId,
    };
    // Current from here on, so a Stop during the waits below is seen.
    this.turn = turn;
    const onState = (agent: AgentActivity): void => this.onAgentState(turn, agent);
    client.on("agent_state", onState);
    try {
      await client.waitUntilConnected(this.options.connectTimeoutMs ?? 5000).catch(() => {
        throw new Error(`the agent host is not reachable (${client.status}); the room's agents cannot run until it is back`);
      });
      // Asked again after the waits above: a stop or a removal may have
      // landed meanwhile.
      this.checkAdmitted();
      if (this.resetPending) {
        this.closeSubscription();
        await client.request("remove", { agentId: this.agentId }).catch((error: unknown) => {
          if (!(error instanceof HostRequestError && error.code === "unknown_agent")) throw error;
        });
        this.resetPending = false;
      }
      if (turn.stopRequested) return { stopped: true };
      await this.deliver(client, ctx.prompt, spec);
      return await done;
    } catch (error) {
      turn.settled = true;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(this.describeFailure(message, setup), { cause: error });
    } finally {
      client.off("agent_state", onState);
      if (this.turn === turn) this.turn = undefined;
    }
  }

  /**
   * Follows a turn that was already running in the host when this relay
   * started (or reconnected): reads the agent's log from the last record
   * this relay processed (or from its end, if it never saw one) and maps it
   * like a turn of its own, to its end. Resolves at once when the agent is
   * not in a turn.
   */
  async followTurnInFlight(onEvent: (event: AgentEvent) => void): Promise<DriverTurnResult> {
    const client = this.options.binding.client;
    if (!client || this.retired || this.turn) return { stopped: false };
    let resolveTurn!: (result: DriverTurnResult) => void;
    let rejectTurn!: (error: Error) => void;
    const done = new Promise<DriverTurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const turn: ActiveTurn = {
      onEvent,
      resolve: (result) => {
        if (turn.settled) return;
        turn.settled = true;
        resolveTurn(result);
      },
      reject: (error) => {
        if (turn.settled) return;
        turn.settled = true;
        rejectTurn(error);
      },
      started: true,
      settled: false,
      stopRequested: false,
      memos: new Map(),
    };
    const onState = (agent: AgentActivity): void => {
      this.onAgentState(turn, agent);
      // Idle with no end of turn read: it ended in a gap this relay cannot
      // replay. Given a moment for the record itself to arrive first.
      if (agent.agentId === this.agentId && agent.alive && agent.state !== "working" && agent.state !== "starting") {
        setTimeout(() => turn.resolve({ stopped: false, contextUsage: turn.contextUsage, lastAssistantText: turn.lastAssistantText }), 1000).unref();
      }
    };
    client.on("agent_state", onState);
    try {
      const { agents } = await client.request<{ agents: AgentActivity[] }>("activity");
      const agent = agents.find((candidate) => candidate.agentId === this.agentId);
      if (!agent || (agent.state !== "working" && agent.state !== "starting")) return { stopped: false };
      if (agent.sessionId && this.daemonPlan) this.sessionId = agent.sessionId;
      this.turn = turn;
      const saved = this.options.binding.cursors?.get(this.agentId);
      this.subscribe(client, saved ?? { nextOffset: agent.nextOffset, lastSeq: -1 });
      return await done;
    } finally {
      client.off("agent_state", onState);
      if (this.turn === turn) this.turn = undefined;
    }
  }

  /** Room tools the agent's runtime refused to take are a failure the
   * person has to see as such: the room never swaps the agent for another
   * one behind their back. Codex takes them as dynamic tools, an
   * experimental part of its app-server; a version without them refuses the
   * thread that declares them. */
  private describeFailure(message: string, setup: RoomAgentSetup | undefined): string {
    if (!this.daemonPlan || !setup || !/could not start a Codex thread/i.test(message)) return message;
    // Only a refusal that names the dynamic tools (or an unknown field, the
    // way a parser without them answers) is their absence; anything else
    // (not logged in, a crashed app-server) is said as it is.
    if (/dynamicTools|unknown field|experimental/i.test(message)) {
      return `The room's tools are not available with this version of Codex (${message}). This room stays on Codex: nothing was switched to another agent.`;
    }
    return `Codex could not start this agent (${message}). This room stays on Codex: nothing was switched to another agent.`;
  }

  /** Writes the message to the agent, creating it in the host first if the
   * host does not have it. */
  private async deliver(client: HostClient, prompt: string, spec: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Stopped before the message left: it is never sent.
      if (this.turn?.stopRequested) {
        this.turn.resolve({ stopped: true });
        return;
      }
      if (await this.ensureSubscription(client)) {
        try {
          await client.request("send", { agentId: this.agentId, message: prompt });
          return;
        } catch (error) {
          if (!(error instanceof HostRequestError && error.code === "unknown_agent")) throw error;
          this.closeSubscription();
        }
      }
      // Creating it is the one step that could bring a stopped or removed
      // agent back: asked once more right before.
      this.checkAdmitted();
      try {
        const created = await client.request<AgentActivity>("spawn", {
          agentId: this.agentId,
          runtime: this.def.identity.id,
          spec,
          message: prompt,
          ...(this.options.binding.roomId ? { roomId: this.options.binding.roomId } : {}),
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        });
        if (created.sessionId) this.sessionId = created.sessionId;
        this.subscribe(client, START_OF_LOG);
        return;
      } catch (error) {
        // Created meanwhile (a turn of another relay process, a retry): send to it.
        if (!(error instanceof HostRequestError && error.code === "agent_exists")) throw error;
      }
    }
    throw new Error(`could not reach agent ${this.agentId} in the agent host`);
  }

  /** Subscribes to the agent's log from its current end, if the host has
   * the agent. Whether it does. */
  private async ensureSubscription(client: HostClient): Promise<boolean> {
    if (this.subscription) return true;
    const { agents } = await client.request<{ agents: AgentActivity[] }>("activity");
    const agent = agents.find((candidate) => candidate.agentId === this.agentId);
    if (!agent) return false;
    if (agent.sessionId && this.daemonPlan) this.sessionId = agent.sessionId;
    this.subscribe(client, { nextOffset: agent.nextOffset, lastSeq: -1 });
    return true;
  }

  private subscribe(client: HostClient, from: AgentCursor): void {
    this.subscription?.close();
    const subscription = client.subscribe(this.agentId, from, {
      onEvent: (record) => this.onRecord(record),
      onError: (error) => {
        if (this.subscription === subscription) this.subscription = undefined;
        const turn = this.turn;
        if (turn && !turn.settled) turn.reject(new Error(`the agent host ended this agent's stream (${error.code}): ${error.message}`));
      },
    });
    this.subscription = subscription;
  }

  /** Backup for a log record that never comes (the host restarted while the
   * agent was mid-turn and brought it back stopped). */
  private onAgentState(turn: ActiveTurn, agent: AgentActivity): void {
    if (agent.agentId !== this.agentId || !turn.started || turn.settled || agent.alive) return;
    if (agent.state !== "stopped" && agent.state !== "failed") return;
    if (turn.stopRequested || agent.stopReason === "user") turn.resolve({ stopped: true, contextUsage: turn.contextUsage, lastAssistantText: turn.lastAssistantText });
    else turn.reject(new Error(agent.failure ?? `the agent ${agent.state}${agent.stopReason ? ` (${agent.stopReason})` : ""}`));
  }

  listSubtasks(): SubtaskInfo[] {
    return this.subtasks.list();
  }

  async stopSubtask(taskId: string): Promise<"stopping" | "unknown"> {
    const client = this.options.binding.client;
    if (this.daemonPlan || !client || this.subtasks.get(taskId)?.status !== "running") return "unknown";
    await client.request("stop_task", { agentId: this.agentId, taskId });
    return "stopping";
  }

  private onRecord(record: EventMessage): void {
    this.options.binding.cursors?.set(this.agentId, { nextOffset: record.next, lastSeq: record.seq, incarnation: record.inc });
    const event = record.ev;
    if (!this.daemonPlan && !this.resetPending && typeof event.session_id === "string") this.sessionId = event.session_id;
    if (!this.daemonPlan) this.subtasks.observe(event);
    // A native subagent's permission request carries its `agent_id`: once
    // approvals are deferred to the person, it belongs to this agent's card
    // as a pending approval named after the subtask
    // (`this.subtasks.labelFor(agent_id)`). This agent's process gets no
    // permission prompt over stdio today, so none arrives here yet.
    const turn = this.turn;
    if (!turn || turn.settled) return;
    if (!turn.started) {
      if (event.type === "host_user_message") turn.started = true;
      return;
    }
    if (event.type === "host_process") {
      this.onProcessRecord(turn, event);
      return;
    }
    if (typeof event.type === "string" && event.type.startsWith("host_")) {
      if (event.type === "host_codex_request_declined") {
        turn.onEvent({ type: "error", message: "The agent asked for an approval or an answer, which an agent of a room cannot get yet; it was declined." });
      }
      return;
    }
    if (this.daemonPlan) this.onCodexEvent(turn, this.daemonPlan, event);
    else this.onClaudeEvent(turn, event as ClaudeEvent);
  }

  private onProcessRecord(turn: ActiveTurn, event: Record<string, unknown>): void {
    const subtype = event.subtype;
    if (subtype !== "exited" && subtype !== "lost") return;
    if (turn.stopRequested || (subtype === "exited" && event.expected === true)) {
      turn.resolve({ stopped: true, contextUsage: turn.contextUsage, lastAssistantText: turn.lastAssistantText });
      return;
    }
    turn.reject(new Error(subtype === "lost" ? "the agent host went away during the turn" : `the agent's process exited during the turn (code ${String(event.code)}, signal ${String(event.signal)})`));
  }

  private onClaudeEvent(turn: ActiveTurn, event: ClaudeEvent): void {
    if (event.type === "control_response" || event.type === "host_unparsed") return;
    // Same filter as a direct turn: `user` lines that are not tool results are
    // the CLI's own synthetic noise (skill bodies, reminders).
    if (event.type === "user" && !isToolResultOnly((event.message as { content?: unknown } | undefined)?.content)) return;
    if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") turn.lastModel = event.model;
    if (event.type === "assistant" && isMainThreadEvent(event)) {
      const message = event.message as { usage?: ResultUsage; content?: { type?: string; text?: string }[] } | undefined;
      if (message?.usage) turn.lastMainThreadUsage = message.usage;
      const texts = message?.content?.filter((block) => block.type === "text" && block.text);
      if (texts && texts.length > 0) turn.lastAssistantText = texts.map((block) => block.text).join("\n");
    }
    for (const mapped of mapClaudeEvent(event, turn.memos)) turn.onEvent(mapped);
    if (event.type !== "result") return;
    turn.contextUsage = extractContextUsage(event, turn.lastModel, turn.lastMainThreadUsage) ?? turn.contextUsage;
    if (event.is_error) {
      if (turn.stopRequested) {
        turn.resolve({ stopped: true, contextUsage: turn.contextUsage, lastAssistantText: turn.lastAssistantText });
        return;
      }
      const message = event.errors?.join("; ") || event.result || "the agent reported an error without a message";
      // The host's agent holds a conversation that cannot be resumed: start
      // a fresh one on the next turn.
      if (isSessionInvalidError(message)) this.resetSessionId();
      turn.reject(new Error(message));
      return;
    }
    turn.resolve({ stopped: false, contextUsage: turn.contextUsage, lastAssistantText: turn.lastAssistantText });
  }

  private onCodexEvent(turn: ActiveTurn, plan: JsonRpcDaemonPlan, event: Record<string, unknown>): void {
    if (event.type !== "codex_notification" || typeof event.method !== "string") return;
    const method = event.method;
    const params = event.params;
    if (method === "turn/started") return;
    if (method === "turn/completed") {
      const info = isRecord(params) && isRecord(params.turn) ? params.turn : {};
      const status = info.status;
      if (status === "failed") {
        const error = isRecord(info.error) && typeof info.error.message === "string" ? info.error.message : "the Codex turn failed";
        turn.reject(new Error(error));
        return;
      }
      const contextUsage: ContextUsage | undefined =
        turn.modelId && turn.codexUsage?.contextWindowSize !== undefined
          ? { model: turn.modelId, contextWindowSize: turn.codexUsage.contextWindowSize, usedTokens: turn.codexUsage.prefixTokens }
          : undefined;
      turn.resolve({ stopped: status === "interrupted" || turn.stopRequested, contextUsage, lastAssistantText: turn.lastAssistantText });
      return;
    }
    const turnId = isRecord(params) && typeof params.turnId === "string" ? params.turnId : "";
    for (const mapped of plan.mapNotification(method, params, { turnId })) {
      if (mapped.type === "text") turn.lastAssistantText = mapped.text;
      if (mapped.type === "usage") turn.codexUsage = { prefixTokens: mapped.prefixTokens, contextWindowSize: mapped.contextWindowSize };
      turn.onEvent(mapped);
    }
  }
}
