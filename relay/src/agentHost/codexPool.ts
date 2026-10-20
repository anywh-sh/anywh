// Codex agents in the host: ONE `codex app-server` for the whole host
// (profile), one thread per agent, over the same transport the relay's own
// Codex sessions use (`runtimes/transports/codexDaemon.ts`).
//
// SKELETON — not validated against a real `codex app-server`. Everything
// here is exercised only against a fake app-server speaking the shapes the
// Codex def was checked against (codex-cli 0.154.0 generated bindings).
// Known gaps, on purpose:
//   - Approvals and structured questions from Codex are declined/deferred
//     and recorded in the agent's log: deferring a human intervention to a
//     later turn is not designed for Codex yet.
//   - Hibernating a Codex agent ends no process (the app-server is shared;
//     its own idle reaper frees it when nothing runs): it only gives up the
//     agent's room slot. After the daemon or the host restarts, a turn is
//     sent on the agent's existing thread id, the same assumption the
//     relay's own Codex driver makes.
//   - A message sent while a turn is in flight is refused rather than
//     steering the turn.
//   - Stopping a Codex agent interrupts its turn; its tools' processes are
//     the shared daemon's children and are not ended per agent.
import { codexRuntimeDef } from "../runtimes/defs/codex.js";
import { daemonPlanOf, spawnCodexDaemon, type CodexDaemon } from "../runtimes/transports/codexDaemon.js";
import type { AgentRuntimeDef, ApprovalRequest, JsonRpcDaemonPlan, RoomToolCall, TurnContext, TurnHost, UserInputQuestion } from "../runtimes/types.js";
import { AGENT_MARK_ENV, agentMark } from "./processTree.js";

/** The agent id the shared app-server carries in its environment marker. */
export const CODEX_DAEMON_MARKER = "codex-app-server";

export interface CodexPoolOptions {
  readonly hostId: string;
  readonly incarnation: string;
  readonly homeOverride?: string;
  /** Overridable so a test can point the real def at a fake app-server. */
  readonly def?: AgentRuntimeDef;
  /** Daemon working directory (threads carry their own `cwd`). */
  readonly cwd: string;
  readonly onNotification: (threadId: string | undefined, method: string, params: unknown) => void;
  /** A request from Codex that needed a human; recorded, then declined. */
  readonly onServerRequest: (threadId: string | undefined, kind: "approval" | "user_input", detail: unknown) => void;
  readonly onExit: (reason: string) => void;
  /** A room tool called through Codex's dynamic tools, on the thread of
   * `call.threadId`. Answered at once. */
  readonly onRoomToolCall?: (call: RoomToolCall) => Promise<{ text: string; isError: boolean }>;
}

function threadIdOf(params: unknown): string | undefined {
  const value = (params as { threadId?: unknown } | null | undefined)?.threadId;
  return typeof value === "string" ? value : undefined;
}

export class CodexPool {
  private daemon: CodexDaemon | undefined;
  private starting: Promise<CodexDaemon> | undefined;
  private readonly def: AgentRuntimeDef;
  private readonly plan: JsonRpcDaemonPlan;

  constructor(private readonly options: CodexPoolOptions) {
    const base = options.def ?? codexRuntimeDef;
    const plan = daemonPlanOf(base);
    if (!plan) throw new Error("the Codex def must be a JSON-RPC daemon");
    this.plan = plan;
    // The marker lets a restarted host find an app-server its previous run
    // left behind, like any agent process.
    this.def = {
      ...base,
      identity: {
        ...base.identity,
        env: { ...base.identity.env, set: { ...base.identity.env.set, [AGENT_MARK_ENV]: agentMark(options.hostId, CODEX_DAEMON_MARKER, options.incarnation) } },
      },
    };
  }

  get defaultPermissionModeId(): string {
    return this.def.permissions.defaultModeId;
  }

  private ensure(): Promise<CodexDaemon> {
    if (this.daemon && !this.daemon.exited) return Promise.resolve(this.daemon);
    this.starting ??= spawnCodexDaemon({
      def: this.def,
      cwd: this.options.cwd,
      homeOverride: this.options.homeOverride,
      host: this.turnHostFor(),
      onNotification: (method, params) => this.options.onNotification(threadIdOf(params), method, params),
      onExit: (reason) => {
        this.daemon = undefined;
        this.options.onExit(reason);
      },
    }).then(
      (daemon) => {
        this.daemon = daemon;
        this.starting = undefined;
        return daemon;
      },
      (error: unknown) => {
        this.starting = undefined;
        throw error;
      },
    );
    return this.starting;
  }

  private turnHostFor(): TurnHost {
    return {
      requestApproval: (request: ApprovalRequest) => {
        this.options.onServerRequest(undefined, "approval", request);
        const decline = request.safeDecisionId ?? request.availableDecisions.find((decision) => /decline|deny|cancel/i.test(decision.id))?.id ?? "decline";
        return Promise.resolve(decline);
      },
      requestUserInput: (questions: readonly UserInputQuestion[]) => {
        this.options.onServerRequest(undefined, "user_input", questions);
        return Promise.resolve("deferred" as const);
      },
      ...(this.options.onRoomToolCall ? { callRoomTool: this.options.onRoomToolCall } : {}),
    };
  }

  async startThread(ctx: TurnContext): Promise<string> {
    const daemon = await this.ensure();
    const spec = this.plan.thread.start(ctx);
    const result = (await daemon.request(spec.method, spec.params)) as { thread: { id: string } };
    return result.thread.id;
  }

  async startTurn(ctx: TurnContext, threadId: string): Promise<string> {
    const daemon = await this.ensure();
    const spec = this.plan.turn.start(ctx, threadId);
    const result = (await daemon.request(spec.method, spec.params)) as { turn: { id: string } };
    return result.turn.id;
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    if (!this.daemon || this.daemon.exited) return;
    const spec = this.plan.turn.interrupt(threadId, turnId);
    await this.daemon.request(spec.method, spec.params);
  }

  get running(): boolean {
    return this.daemon !== undefined && !this.daemon.exited;
  }

  close(): void {
    this.daemon?.kill();
    this.daemon = undefined;
  }
}
