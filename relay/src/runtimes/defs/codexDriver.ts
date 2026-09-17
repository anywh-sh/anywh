// Codex's AgentSessionDriver — owns the one `CodexDaemon` (runtimes/transports/codexDaemon.ts)
// a `SharedSession` driving a Codex thread keeps alive across turns, and
// translates the daemon's own request/notification vocabulary into
// `AgentSessionDriver`'s contract. Style precedent: `defs/claude/driver.ts`
// (spawn-per-turn's equivalent), but the two don't share code — a daemon's
// lifecycle (spawn once, reuse across turns, tear down on `dispose()`) has
// nothing in common with a process spawned fresh per turn.
//
// The one piece this file had to get right that no doc comment elsewhere in
// this codebase already covers: `turn/start`'s own JSON-RPC response
// resolves as soon as Codex ACCEPTS the turn (`Turn.status: "inProgress"`),
// not when the turn actually finishes — otherwise `turn/interrupt` (which
// needs the turn's id while it's still running) could never fire in time to
// interrupt anything. Completion arrives later, asynchronously, as a
// `turn/completed` notification. Verified against real generated bindings
// (`codex app-server generate-ts --experimental`, `codex-cli 0.154.0`):
// `TurnStartResponse = { turn: Turn }`, `TurnCompletedNotification =
// { threadId, turn: Turn }`, `Turn.status: "completed" | "interrupted" |
// "failed" | "inProgress"` — the same rigor bar `defs/codex.ts`'s own header
// comment holds itself to, just for the piece that file didn't need yet.
import { spawnCodexDaemon, type CodexDaemon } from "../transports/codexDaemon.js";
import type { AgentEvent, AgentRuntimeDef, JsonRpcDaemonPlan, TurnContext } from "../types.js";
import type { AgentSessionDriver, DriverTurnResult, SessionDriverHost } from "../sessionDriver.js";

export interface CodexSessionDriverOptions {
  readonly homeOverride?: string;
  readonly initialSessionId?: string;
  readonly host: SessionDriverHost;
}

// Locally-typed subset of the real generated bindings this file consumes —
// same "curated, not vendored" approach `runtimes/streams/codexAppServer.ts`
// already established, for the same reason (most of the generated surface,
// e.g. `Turn.items`/`itemsView`/`startedAt`, is irrelevant to driving a turn).
interface ThreadStartResult {
  readonly thread: { readonly id: string };
}
interface TurnStartResult {
  readonly turn: { readonly id: string };
}
interface TurnCompletionInfo {
  readonly id: string;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
  readonly error: { readonly message: string } | null;
}
interface TurnCompletedParams {
  readonly threadId: string;
  readonly turn: TurnCompletionInfo;
}

/** Notifications this driver itself consumes for turn-lifecycle bookkeeping
 * rather than handing to `exec.mapNotification` — mirrors
 * `codexAppServer.ts`'s own file comment that turn lifecycle is
 * deliberately never mapped to an `AgentEvent` (`SharedSession` synthesizes
 * `turn_started`/`turn_ended` structurally instead). Forwarding either of
 * these into `mapNotification` would only earn a spurious "unrecognized
 * notification" log line from its `default` branch. */
const TURN_LIFECYCLE_METHODS = new Set(["turn/started", "turn/completed"]);

function isJsonRpcDaemonPlan(def: AgentRuntimeDef): def is AgentRuntimeDef & { exec: JsonRpcDaemonPlan } {
  return def.exec.kind === "jsonRpcDaemon";
}

export class CodexSessionDriver implements AgentSessionDriver {
  private readonly def: AgentRuntimeDef & { exec: JsonRpcDaemonPlan };
  private readonly homeOverride: string | undefined;
  private readonly host: SessionDriverHost;
  private daemon: CodexDaemon | undefined;
  /** == `getSessionId()`'s backing value — a Codex thread id, not a
   * process handle. `undefined` until the first turn's `thread/start`
   * resolves, or after `resetSessionId()` (`/clear`). */
  private threadId: string | undefined;
  private inFlightTurnId: string | undefined;
  /** Set for the duration of `sendTurn`, cleared in its `finally` — the
   * turn currently awaiting a `turn/completed` notification. Rejected
   * instead if the daemon dies mid-turn (`ensureDaemon`'s `onExit`), so a
   * crashed process never leaves `sendTurn` hanging forever. */
  private pendingTurn: { readonly resolve: (turn: TurnCompletionInfo) => void; readonly reject: (error: Error) => void } | undefined;
  /** Set for the duration of `sendTurn` — `handleNotification` forwards
   * every non-lifecycle notification here, mapped to `AgentEvent`s. */
  private pendingOnEvent: ((event: AgentEvent) => void) | undefined;

  constructor(def: AgentRuntimeDef, options: CodexSessionDriverOptions) {
    if (!isJsonRpcDaemonPlan(def)) throw new Error(`CodexSessionDriver: def "${def.identity.id}" has no jsonRpcDaemon exec plan`);
    this.def = def;
    this.homeOverride = options.homeOverride;
    this.host = options.host;
    this.threadId = options.initialSessionId;
  }

  getSessionId(): string | undefined {
    return this.threadId;
  }

  setSessionId(sessionId: string): void {
    this.threadId = sessionId;
  }

  resetSessionId(): void {
    this.threadId = undefined;
  }

  /** One daemon per `SharedSession`, spawned lazily on the first `sendTurn`
   * — never in a driver's own constructor, which `SessionManager` calls for
   * every persisted session at boot, live or not. Respawned transparently
   * if the previous one exited (idle reaper, crash) — a fresh process can
   * still reference an existing `threadId`: Codex persists thread state of
   * its own, independent of which `codex app-server` process is currently
   * attached to it (`continuity: { kind: "cli-resume" }` in `defs/codex.ts`). */
  private async ensureDaemon(cwd: string): Promise<CodexDaemon> {
    if (this.daemon && !this.daemon.exited) return this.daemon;
    this.daemon = await spawnCodexDaemon({
      def: this.def,
      cwd,
      homeOverride: this.homeOverride,
      host: this.host,
      onNotification: (method, params) => this.handleNotification(method, params),
      onExit: () => {
        this.daemon = undefined;
        if (this.pendingTurn) {
          const { reject } = this.pendingTurn;
          this.pendingTurn = undefined;
          reject(new Error("Codex daemon exited before the turn completed"));
        }
      },
    });
    return this.daemon;
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "turn/completed") {
      const { turn } = params as TurnCompletedParams;
      if (this.pendingTurn && turn.id === this.inFlightTurnId) {
        const { resolve } = this.pendingTurn;
        this.pendingTurn = undefined;
        resolve(turn);
      }
      return;
    }
    if (TURN_LIFECYCLE_METHODS.has(method)) return;
    for (const event of this.def.exec.mapNotification(method, params, { turnId: this.inFlightTurnId ?? "" })) {
      this.pendingOnEvent?.(event);
    }
  }

  async sendTurn(ctx: TurnContext, onEvent: (event: AgentEvent) => void): Promise<DriverTurnResult> {
    const exec = this.def.exec;
    const daemon = await this.ensureDaemon(ctx.cwd);
    let lastAssistantText: string | undefined;
    this.pendingOnEvent = (event) => {
      if (event.type === "text") lastAssistantText = event.text;
      onEvent(event);
    };
    try {
      if (!this.threadId) {
        const startSpec = exec.thread.start(ctx);
        const threadResult = (await daemon.request(startSpec.method, startSpec.params)) as ThreadStartResult;
        this.threadId = threadResult.thread.id;
      }
      const turnSpec = exec.turn.start(ctx, this.threadId);
      const turnStartResult = (await daemon.request(turnSpec.method, turnSpec.params)) as TurnStartResult;
      this.inFlightTurnId = turnStartResult.turn.id;

      const turn = await new Promise<TurnCompletionInfo>((resolve, reject) => {
        this.pendingTurn = { resolve, reject };
      });

      if (turn.status === "failed") throw new Error(turn.error?.message ?? `Codex turn ${turn.id} failed`);
      // No `contextUsage` yet — `thread/tokenUsage/updated`'s real payload
      // does carry `modelContextWindow` (confirmed against the generated
      // bindings), but `codexAppServer.ts`'s local `ThreadTokenUsageUpdatedParams`
      // doesn't capture it yet, and there's no `model` field on the
      // notification at all (it lives on `thread/start`'s response
      // instead) — wiring a real `ContextUsage` together is follow-up work,
      // not invented here.
      return { stopped: turn.status === "interrupted", lastAssistantText };
    } finally {
      this.inFlightTurnId = undefined;
      this.pendingTurn = undefined;
      this.pendingOnEvent = undefined;
    }
  }

  /** Fire-and-forget, same shape as `ClaudeSession`'s SIGINT: the in-flight
   * `sendTurn` settles from the `turn/completed` notification this
   * triggers (`Turn.status: "interrupted"`), never from this request's own
   * result. Returns `false` without sending anything if there's nothing to
   * interrupt — same contract `ClaudeSessionDriver.stop` already has. */
  stop(): boolean {
    if (!this.daemon || this.daemon.exited || !this.threadId || !this.inFlightTurnId) return false;
    const spec = this.def.exec.turn.interrupt(this.threadId, this.inFlightTurnId);
    void this.daemon.request(spec.method, spec.params).catch(() => {});
    return true;
  }

  /** Tears down the daemon process — called once, from `SharedSession.dispose()`,
   * never from `stop()` (invariant 3: killing a turn never destroys the
   * session). Idempotent: `CodexDaemon.kill()` already is. */
  dispose(): void {
    this.daemon?.kill();
  }

  // No `rewind` — `codexRuntimeDef.capabilities.rewindTurn` is `"none"`
  // today (`defs/codex.ts`), and `AgentSessionDriver.rewind`'s own contract
  // is to simply not exist on a driver with nothing to rewind, rather than
  // exist and throw.
}
