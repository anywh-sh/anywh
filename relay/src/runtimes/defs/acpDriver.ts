// The AgentSessionDriver for every agent that speaks the Agent Client
// Protocol (`exec.protocol: "acp"`) — one engine, any number of defs. Owns
// one daemon process per session (the same transport Codex uses,
// `runtimes/transports/codexDaemon.ts`), kept across turns and torn down on
// `dispose()`.
//
// What sets ACP apart from Codex's app-server, and shapes this file:
//   - `session/prompt` answers only when the turn is over, with a
//     `stopReason` — no lifecycle notifications, no per-turn id. The turn is
//     the request.
//   - `session/cancel` is a notification. ACP then expects the client to
//     answer every permission request still open with `cancelled`, so a
//     stop has to release those too, or the agent waits on them and the
//     turn never ends.
//   - the session's picks (mode, model, reasoning level) are set with their
//     own requests before a prompt (`exec.configureSession`), not on it.
//   - a stored session has to be attached to a new process before a prompt:
//     `session/resume` for a turn, `session/load` (which replays it) for
//     history.
//   - messages and tool calls stream in pieces, so the mapper keeps per-turn
//     state (`exec.turnState`) and is flushed when the turn ends.
import { spawnCodexDaemon, type CodexDaemon } from "../transports/codexDaemon.js";
import type { AgentEvent, AgentRuntimeDef, ApprovalRequest, JsonRpcDaemonPlan, JsonRpcRequestSpec, TurnContext, TurnHost, UserInputQuestion } from "../types.js";
import type { AgentSessionDriver, DriverTurnResult, SessionDriverHost } from "../sessionDriver.js";
import { acpConfigOptions, acpCurrentValue, isAcpSessionGoneError } from "./acp.js";
// Same known reverse-direction dependency `codexDriver.ts` has, for the
// same type.
// eslint-disable-next-line import-x/no-restricted-paths
import type { ContextUsage } from "../../session/sessionStore.js";
import { planUsageCapture, planUsageRuntimeOf, type PlanUsageCapture } from "../../planUsage/index.js";

export interface AcpSessionDriverOptions {
  readonly homeOverride?: string;
  readonly initialSessionId?: string;
  readonly host: SessionDriverHost;
  /** Where the turn's start and end go (a finished turn re-reads the plan
   * usage); the relay's shared capture unless a test passes its own. */
  readonly planUsage?: PlanUsageCapture;
}

type AcpPlan = JsonRpcDaemonPlan & { readonly protocol: "acp" };

function isAcpPlan(def: AgentRuntimeDef): def is AgentRuntimeDef & { exec: AcpPlan } {
  return def.exec.kind === "jsonRpcDaemon" && def.exec.protocol === "acp";
}

class TurnCancelled extends Error {
  constructor() {
    super("the turn was cancelled");
    this.name = "TurnCancelled";
  }
}

const STREAMING_ONLY: ReadonlySet<AgentEvent["type"]> = new Set(["text_delta", "thinking_delta", "thinking_started", "tool_input_delta", "tool_progress"]);

interface StopReasonResult {
  readonly stopReason?: string;
}

/** The key a `configureSession` request is remembered under: its method,
 * plus the config option it sets when it sets one. */
function configKey(spec: JsonRpcRequestSpec): string {
  const configId = (spec.params as { configId?: unknown } | null)?.configId;
  return typeof configId === "string" ? `${spec.method}:${configId}` : spec.method;
}

export class AcpSessionDriver implements AgentSessionDriver {
  private readonly def: AgentRuntimeDef & { exec: AcpPlan };
  private readonly homeOverride: string | undefined;
  private readonly host: SessionDriverHost;
  private readonly planUsage: PlanUsageCapture;
  private daemon: CodexDaemon | undefined;
  private sessionId: string | undefined;
  /** Whether `sessionId` is attached to the current process: a fresh
   * process knows no session until `session/new`, `session/resume` or
   * `session/load` names it. */
  private attached = false;
  /** The last `configureSession` request sent per key on this session. */
  private sentConfig = new Map<string, string>();
  /** The model the session runs, as the agent last reported it. */
  private currentModel: string | undefined;
  private inFlight = false;
  /** Rejected by `stop()` so every approval/question still open gives up and
   * answers `cancelled`; replaced at every turn. */
  private cancelTurn: (() => void) | undefined;
  private cancelled: Promise<never> | undefined;
  /** Where `session/update`s go: the live turn's mapper, or a replay's. */
  private onUpdate: ((method: string, params: unknown) => void) | undefined;
  /** Each tool call's parsed input, by id, as the updates reported it — so
   * a permission request naming the call (which carries no input of its
   * own) can say what it is asking about. */
  private toolInputs = new Map<string, unknown>();

  constructor(def: AgentRuntimeDef, options: AcpSessionDriverOptions) {
    if (!isAcpPlan(def)) throw new Error(`AcpSessionDriver: def "${def.identity.id}" has no ACP exec plan`);
    this.def = def;
    this.homeOverride = options.homeOverride;
    this.host = options.host;
    this.planUsage = options.planUsage ?? planUsageCapture;
    this.sessionId = options.initialSessionId;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    this.attached = false;
    this.sentConfig.clear();
  }

  resetSessionId(): void {
    this.sessionId = undefined;
    this.attached = false;
    this.sentConfig.clear();
  }

  /** The `TurnHost` the daemon answers server requests through: the
   * session's own, except that a stopped turn makes every open request give
   * up at once instead of waiting on a human. */
  private readonly turnHost: TurnHost = {
    requestApproval: (request: ApprovalRequest) => this.raceCancel(this.host.requestApproval(request)),
    requestUserInput: (questions: readonly UserInputQuestion[]) => this.raceCancel(this.host.requestUserInput(questions)),
  };

  private raceCancel<T>(promise: Promise<T>): Promise<T> {
    return this.cancelled ? Promise.race([promise, this.cancelled]) : promise;
  }

  /** A permission request carries the tool call's id and title but not its
   * input; the input arrived on an earlier update, so it is added back. */
  private withToolInput(method: string, params: unknown): unknown {
    if (method !== "session/request_permission") return params;
    const toolCall = (params as { toolCall?: { toolCallId?: unknown; rawInput?: unknown } } | null)?.toolCall;
    if (!toolCall || toolCall.rawInput !== undefined || typeof toolCall.toolCallId !== "string") return params;
    const rawInput = this.toolInputs.get(toolCall.toolCallId);
    return rawInput === undefined ? params : { ...(params as object), toolCall: { ...toolCall, rawInput } };
  }

  private rememberToolInput(params: unknown): void {
    const update = (params as { update?: { toolCallId?: unknown; rawInput?: unknown } } | null)?.update;
    if (update && typeof update.toolCallId === "string" && update.rawInput !== undefined) this.toolInputs.set(update.toolCallId, update.rawInput);
  }

  private async ensureDaemon(cwd: string): Promise<CodexDaemon> {
    if (this.daemon && !this.daemon.exited) return this.daemon;
    const exec = this.def.exec;
    this.attached = false;
    this.sentConfig.clear();
    this.daemon = await spawnCodexDaemon({
      def: { ...this.def, exec: { ...exec, handleServerRequest: (method, params, host) => exec.handleServerRequest(method, this.withToolInput(method, params), host) } },
      cwd,
      homeOverride: this.homeOverride,
      host: this.turnHost,
      onNotification: (method, params) => {
        if (method === "session/update") {
          const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
          if (sessionId !== undefined && sessionId !== this.sessionId) return;
          this.rememberToolInput(params);
        }
        this.onUpdate?.(method, params);
      },
      onExit: () => {
        this.daemon = undefined;
        this.attached = false;
      },
    });
    return this.daemon;
  }

  private noteConfig(result: unknown): void {
    const model = acpCurrentValue(acpConfigOptions(result), "model");
    if (model) this.currentModel = model;
  }

  /** Makes sure the session exists on this process, creating or resuming it. */
  private async attach(daemon: CodexDaemon, ctx: TurnContext): Promise<string> {
    const exec = this.def.exec;
    if (this.sessionId && this.attached) return this.sessionId;
    if (!this.sessionId) {
      const spec = exec.thread.start(ctx);
      const result = await daemon.request(spec.method, spec.params);
      const sessionId = (result as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId !== "string") throw new Error(`${this.def.identity.id}: ${spec.method} answered without a sessionId`);
      this.sessionId = sessionId;
      this.noteConfig(result);
    } else if (exec.thread.resume) {
      const spec = exec.thread.resume(ctx, this.sessionId);
      this.noteConfig(await daemon.request(spec.method, spec.params));
    }
    this.attached = true;
    this.sentConfig.clear();
    return this.sessionId;
  }

  /** Sends the picks that changed since the last turn. Once one is sent,
   * every later one is sent too: a new model can reset the reasoning level
   * the agent had for the old one. */
  private async configure(daemon: CodexDaemon, ctx: TurnContext, sessionId: string): Promise<void> {
    const specs = this.def.exec.configureSession?.(ctx, sessionId) ?? [];
    let resend = false;
    for (const spec of specs) {
      const key = configKey(spec);
      const wire = JSON.stringify(spec.params);
      if (!resend && this.sentConfig.get(key) === wire) continue;
      resend = true;
      this.noteConfig(await daemon.request(spec.method, spec.params));
      this.sentConfig.set(key, wire);
    }
  }

  async sendTurn(ctx: TurnContext, onEvent: (event: AgentEvent) => void): Promise<DriverTurnResult> {
    const exec = this.def.exec;
    const state = exec.turnState?.create();
    let lastAssistantText: string | undefined;
    let lastUsage: { readonly used: number; readonly size?: number } | undefined;
    const emit = (event: AgentEvent): void => {
      if (event.type === "text") lastAssistantText = event.text;
      if (event.type === "usage") lastUsage = { used: event.prefixTokens, size: event.contextWindowSize };
      onEvent(event);
    };
    this.cancelled = new Promise<never>((_resolve, reject) => {
      this.cancelTurn = () => reject(new TurnCancelled());
    });
    // Nothing awaits it until a request races it; a stop with no request
    // open must not surface as an unhandled rejection.
    this.cancelled.catch(() => {});
    this.inFlight = true;
    const planRuntime = planUsageRuntimeOf(this.def.identity.id);
    const endTurn = planRuntime ? this.planUsage.turnStarted(planRuntime) : undefined;
    try {
      const daemon = await this.ensureDaemon(ctx.cwd);
      const sessionId = await this.attach(daemon, ctx);
      await this.configure(daemon, ctx, sessionId);
      this.onUpdate = (method, params) => {
        for (const event of exec.mapNotification(method, params, { turnId: sessionId, state })) emit(event);
      };
      const spec = exec.turn.start(ctx, sessionId);
      const result = (await daemon.request(spec.method, spec.params)) as StopReasonResult | null;
      if (state !== undefined) for (const event of exec.turnState?.flush(state) ?? []) emit(event);
      const model = ctx.modelId ?? this.currentModel;
      const contextUsage: ContextUsage | undefined =
        model && lastUsage?.size !== undefined ? { model, contextWindowSize: lastUsage.size, usedTokens: lastUsage.used } : undefined;
      return { stopped: result?.stopReason === "cancelled", lastAssistantText, contextUsage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAcpSessionGoneError(message)) this.resetSessionId();
      throw error;
    } finally {
      endTurn?.();
      this.inFlight = false;
      this.onUpdate = undefined;
      this.cancelTurn = undefined;
      this.cancelled = undefined;
      this.toolInputs.clear();
    }
  }

  /** Replays the stored session through the same mapper a live turn uses.
   * `session/load` streams the history as `session/update`s before it
   * answers, and leaves the session attached, so the next turn needs no
   * resume. */
  async readHistory(cwd: string): Promise<AgentEvent[]> {
    const exec = this.def.exec;
    const method = exec.replayHistoryMethod;
    if (!this.sessionId || !method || this.inFlight) return [];
    const sessionId = this.sessionId;
    const daemon = await this.ensureDaemon(cwd);
    const state = exec.turnState?.create();
    const events: AgentEvent[] = [];
    this.onUpdate = (notification, params) => {
      events.push(...exec.mapNotification(notification, params, { turnId: sessionId, state }));
    };
    try {
      this.noteConfig(await daemon.request(method, { sessionId, cwd, mcpServers: [] }));
      this.attached = true;
      this.sentConfig.clear();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAcpSessionGoneError(message)) {
        this.resetSessionId();
        return [];
      }
      throw error;
    } finally {
      this.onUpdate = undefined;
      this.toolInputs.clear();
    }
    if (state !== undefined) events.push(...(exec.turnState?.flush(state) ?? []));
    // A replay is already over: the streaming previews a live turn shows
    // add nothing next to the blocks they built.
    return events.filter((event) => !STREAMING_ONLY.has(event.type));
  }

  /** Sends `session/cancel` and releases every open approval/question; the
   * in-flight `sendTurn` then settles from `session/prompt`'s own answer
   * (`stopReason: "cancelled"`). */
  stop(): boolean {
    if (!this.daemon || this.daemon.exited || !this.sessionId || !this.inFlight) return false;
    const spec = this.def.exec.turn.interrupt(this.sessionId, "");
    this.daemon.notify(spec.method, spec.params);
    this.cancelTurn?.();
    return true;
  }

  dispose(): void {
    this.daemon?.kill();
  }

  // No `rewind` — no ACP def declares `rewindTurn` yet.
}
