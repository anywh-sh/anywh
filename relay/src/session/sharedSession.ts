import type { WebSocket } from "ws";
import { ClaudeSession, readHistoryFromTranscript, transcriptPath, forkTruncatedTranscript } from "../runtimes/defs/claude/index.js";
import { mapClaudeEvent } from "../runtimes/streams/claudeStreamJson.js";
import type { AgentEvent } from "../protocol/agent-event.js";
import { checkDirectory, type FsError } from "../fs/fsBrowse.js";
import { type ChoiceAnswer, type ChoiceQuestion, type McpChoiceBridge } from "../bridges/mcpBridge.js";
import { type McpPermissionBridge, type PermissionDecision } from "../bridges/permissionBridge.js";
import { defaultCwd } from "../host/paths.js";
import { formatPlanChoiceAnswerText, parsePlanChoiceMarkers } from "../bridges/planChoiceMarker.js";
import { generateSuggestion } from "../runtimes/probes/suggestionGenerator.js";
import { INITIAL_HISTORY_TAIL_TURNS, findEditTarget, pageHistoryBefore, type EditTarget } from "./historyPaging.js";
import { buildBackgroundJobFollowupPrompt, buildMcpSpawnConfig } from "./turnMessages.js";
import { isPermissionMode, type ContextUsage, type ModelChoice, type PermissionMode } from "./sessionStore.js";
import { toBackgroundJobSummary, type BackgroundJobSummary, type FinishedBackgroundJob, type WatchedJob } from "../host/backgroundJobs.js";
import { ChoiceMachine } from "./choiceMachine.js";
import {
  type BroadcastMessage,
  broadcast,
  broadcastBackgroundJobs,
  broadcastContextUsage,
  broadcastContextUsageReset,
  broadcastConversationReset,
  broadcastCwdState,
  broadcastDraftState,
  broadcastExcept,
  broadcastModelState,
  broadcastPermissionMode,
  broadcastSuggestion,
  broadcastTitle,
  broadcastTurnState,
  sendBackgroundJobs,
  sendContextUsage,
  sendCwdState,
  sendDraftState,
  sendModelState,
  sendPermissionMode,
  sendSuggestion,
  sendTitle,
  sendTurnState,
} from "./broadcast.js";

export type { BroadcastMessage } from "./broadcast.js";

export interface SharedSessionOptions {
  /** session_id already persisted for this session, if any. */
  initialSessionId?: string;
  /** Called with the session_id learned after every successful turn — this
   * is how SessionManager writes it to SessionStore. */
  onSessionIdChange?: (sessionId: string) => void;
  /** Called when `/clear` drops local continuity — this is how
   * SessionManager erases the session_id recorded in SessionStore,
   * otherwise a relay restart would go back to `--resume`ing the
   * already-cleared conversation. */
  onSessionIdClear?: () => void;
  /** Session's current cwd (the app's default if the user never picked a folder). */
  initialCwd: string;
  /** If `true`, the folder has already been consumed by a turn and can no
   * longer change — see the comment in `runTurn` for why. */
  initialLocked: boolean;
  /** Called whenever the cwd changes (only possible before the lock) —
   * this is how SessionManager writes it to SessionStore. */
  onCwdChange?: (cwd: string) => void;
  /** Called exactly once, at the moment the session locks (first real turn). */
  onLockChange?: () => void;
  /** Called when a `/clear` unlocks the cwd of a session that was already
   * locked (see `clearConversation`) — counterpart to `onLockChange`. */
  onUnlockChange?: () => void;
  /** Called by `/clear` to drop the persisted title along with the
   * session_id/history — counterpart to `onSessionIdClear`. Without this,
   * `SessionManager`'s `onFirstPrompt` guard (which exists to protect an
   * already-titled session from being overwritten) would also block the new
   * title a cleared conversation needs. */
  onTitleClear?: () => void;
  /** Title already persisted for this session, if any (an old migrated
   * session, or a reload of a new session whose title had already been
   * inferred before the relay restarted). */
  initialTitle?: string | null;
  /** Called exactly once, with the text of the first message that isn't a
   * command (doesn't start with "/") — SessionManager uses this to trigger
   * title generation in parallel with the turn (doesn't block the
   * response). Deliberately decoupled from `onLockChange`: a session whose
   * first messages are `/model opus`/`/clear` locks the cwd normally on the
   * first turn, but only gets a title once a real message arrives —
   * without this the title would come out of the command text. */
  onFirstPrompt?: (text: string) => void;
  /** Called at the start of EVERY turn (not just the first) — this is what
   * lets SessionManager mark `lastActiveAt` in SessionStore, used to sort
   * the sidebar by last interaction. */
  onActivity?: () => void;
  /** Permission mode already persisted for this session, or
   * `"bypassPermissions"` for a new session — same hardcoded behavior as
   * before this feature existed. */
  initialPermissionMode: PermissionMode;
  /** Called whenever the mode changes — this is how SessionManager writes
   * it to SessionStore. Unlike `onCwdChange`, it can fire at any point in
   * the conversation (not just before the first turn). */
  onPermissionModeChange?: (mode: PermissionMode) => void;
  /** Context usage already persisted for this session (last turn before a
   * possible relay restart), if any. */
  initialContextUsage?: ContextUsage;
  /** Called at the end of every turn that produced a usable `result` — this
   * is how SessionManager writes it to SessionStore. May not fire for a
   * turn that failed before any API call. */
  onContextUsageChange?: (usage: ContextUsage) => void;
  /** Model already persisted for this session, or `undefined` if
   * never chosen via `/model` — in that case `--model` isn't passed on
   * spawn, identical behavior to before this feature existed. */
  initialModel?: ModelChoice;
  /** Called whenever the model changes — same pattern as
   * `onPermissionModeChange`, can fire at any moment. */
  onModelChange?: (model: ModelChoice) => void;
  /** Called with every `AgentEvent` of every turn (real or a background
   * follow-up) — this is how `SessionManager` wires up the
   * `BackgroundJobTracker` without `SharedSession` needing to know anything
   * about `anywh-bg`. Purely observational. */
  onEvent?: (event: AgentEvent) => void;
  /** Called with the id of an `anywh-bg` job the user
   * asked to cancel from the UI. Same reasoning as `onEvent`: `SharedSession`
   * doesn't know anything about `BackgroundJobTracker`, it just passes it
   * along for `SessionManager` to decide what to do. */
  onCancelBackgroundJob?: (jobId: string) => void;
  /** Called whenever a pending `ScheduleWakeup` timer for this session needs
   * cancelling — a real user message (or `/clear`) arriving before it fires,
   * or the session being deleted. Same "SharedSession doesn't know about the
   * mechanism, just reports the intent" pattern as `onCancelBackgroundJob`:
   * the timer itself lives in `SessionManager`'s `WakeupScheduler`. No id
   * (unlike `onCancelBackgroundJob`): at most one wakeup can be armed per
   * session. */
  onCancelWakeup?: () => void;
  /** Draft text already persisted for this session (composer content not
   * yet sent), if any — prompt-draft feature. */
  initialDraft?: string;
  /** Called whenever the draft changes (debounced on the client side) —
   * this is how SessionManager writes it to SessionStore. */
  onDraftChange?: (draft: string) => void;
  /** Next-message suggestion already persisted for this session, if any —
   * survives a relay restart the same way `initialDraft` does (see
   * `suggestion` below for why this changed from in-memory-only). */
  initialSuggestion?: string | null;
  /** Called whenever the suggestion changes (new one generated, or cleared
   * by a new turn/`/clear`/edit) — this is how SessionManager writes it to
   * SessionStore. */
  onSuggestionChange?: (suggestion: string | null) => void;
  /** Shared by every session in the process (like
   * `SessionManager` itself); `undefined` only in tests that don't exercise
   * this feature, in which case `present_choice` is simply never offered to
   * the model (no `--mcp-config` passed), same as before this feature
   * existed. */
  mcpChoiceBridge?: McpChoiceBridge;
  /** Base URL the relay's own HTTP server is reachable at from ITS OWN
   * `claude` child process — always `127.0.0.1`, never the Tailscale address
   * clients use to reach the relay remotely (the child is always local to
   * the relay's machine, `spawn()` never crosses a network, see
   * `runtimes/defs/claude/session.ts`). `undefined` alongside `mcpChoiceBridge` in tests. */
  mcpBridgeBaseUrl?: string;
  /** Same lifecycle/sharing as `mcpChoiceBridge`, just for
   * `--permission-prompt-tool` instead of `present_choice`. `undefined` in
   * tests that don't exercise this feature, same reasoning. */
  mcpPermissionBridge?: McpPermissionBridge;
  /** Same "local-only, own HTTP server" reasoning as `mcpBridgeBaseUrl`, on
   * its own path prefix (`/permission/:token`, mounted separately in
   * `server.ts`) so the two bridges' tokens never share a namespace. */
  mcpPermissionBridgeBaseUrl?: string;
}

/**
 * Every failure the folder picker can report, as a code. Never a sentence:
 * this crosses the wire and the client owns the wording (and the language).
 * `FsError` already worked this way — `locked` is the one case `setCwd` adds
 * on top of it, and it used to be a Portuguese sentence sitting in a field
 * typed `string`, which is how the other four ended up reaching the user as
 * raw enum text.
 */
export type SetCwdError = FsError | "locked";

export type SetCwdResult = { ok: true } | { ok: false; error: SetCwdError };

/** Why an `edit_message` request could not be honored. Same contract as
 * `SetCwdError`: a code, rendered by the client. */
export type EditMessageError = "not_found" | "truncate_failed" | "relay_restarting";

/**
 * A Claude session shared by every client connected to it. New clients
 * receive a history replay before switching over to live events — this is
 * what gives the "real-time shared session" across devices.
 */
export class SharedSession {
  private readonly claude: ClaudeSession;
  private readonly history: BroadcastMessage[] = [];
  private readonly clients = new Set<WebSocket>();
  private turnQueue: Promise<void> = Promise.resolve();
  private cwd: string;
  private locked: boolean;
  private title: string | null;
  private permissionMode: PermissionMode;
  private model: ModelChoice | undefined;
  private draft: string;
  private contextUsage: ContextUsage | undefined;
  /** Next-message suggestion (generated asynchronously at the end of every
   * successful turn, see `runTurn`) — persisted like `draft` (via
   * `onSuggestionChange`/`initialSuggestion`): originally in-memory only,
   * but that meant a relay restart (or rebuild+restart while iterating on
   * the relay itself, a routine occurrence per CLAUDE.md) silently dropped
   * a suggestion that was already showing in the composer's placeholder,
   * with no way to get it back short of a whole new turn. */
  private suggestion: string | null;
  /** Separate from `locked`: a session can lock the cwd on the first turn
   * (e.g. an opening `/model opus`) without yet having a real message for
   * the title — see `onFirstPrompt` above. */
  private firstPromptSeeded = false;
  /** `true` after a `/clear` — prevents `ensureHistoryLoaded` from
   * reloading the old transcript from disk for a client that connects
   * after the clear (its normal guard only looks at `history.length`,
   * which we deliberately zero out on clear). */
  private historyCleared = false;
  /** `null` outside of a turn — timestamp (epoch ms) of when the current
   * turn started, while one is running. "Current" state (like `cwd`),
   * doesn't go into `history`: a client connecting (or reconnecting) picks
   * up the current value via `addClient`, same as `sendCwdState`. */
  private turnStartedAt: number | null = null;
  /** `anywh-bg` jobs currently watched in this session.
   * Same as `contextUsage`/`suggestion`: in-memory only (doesn't persist
   * across a relay restart), it's `BackgroundJobTracker` itself that
   * survives (or not) between restarts — this list is just a mirror of
   * what it knows RIGHT NOW. */
  private backgroundJobs: BackgroundJobSummary[] = [];
  /** Owns `pendingApproval`/`pendingChoice` — the two pending-question slots
   * a session can have open at once — as explicit state instead of fields
   * here. See the class doc comment on `ChoiceMachine` for the full
   * reasoning on why they're separate slots. */
  private readonly choiceMachine: ChoiceMachine;

  constructor(
    private readonly homeOverride: string | undefined,
    private readonly options: SharedSessionOptions,
  ) {
    this.claude = new ClaudeSession({ homeOverride, initialSessionId: options.initialSessionId });
    this.cwd = options.initialCwd;
    this.locked = options.initialLocked;
    this.title = options.initialTitle ?? null;
    this.permissionMode = options.initialPermissionMode;
    this.model = options.initialModel;
    this.contextUsage = options.initialContextUsage;
    this.draft = options.initialDraft ?? "";
    this.suggestion = options.initialSuggestion ?? null;
    this.choiceMachine = new ChoiceMachine(this.clients);
  }

  getCwdState(): { cwd: string; locked: boolean } {
    return { cwd: this.cwd, locked: this.locked };
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  getModel(): ModelChoice | undefined {
    return this.model;
  }

  getContextUsage(): ContextUsage | undefined {
    return this.contextUsage;
  }

  /** Unlike `setCwd`, has no lock or validation — any of the 4 values is
   * always acceptable at any point in the conversation. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.options.onPermissionModeChange?.(mode);
    this.broadcastPermissionMode();
  }

  /** Same pattern as `setPermissionMode` — takes effect from the next turn
   * on, no lock or value validation (the WS handler already validates
   * against `MODEL_CHOICES` before it gets here). */
  setModel(model: ModelChoice): void {
    this.model = model;
    this.options.onModelChange?.(model);
    this.broadcastModelState();
  }

  getDraft(): string {
    return this.draft;
  }

  setDraft(text: string): void {
    this.draft = text;
    this.options.onDraftChange?.(text);
    this.broadcastDraftState();
  }

  getTitle(): string | null {
    return this.title;
  }

  /** Called both by the title inferred from the first prompt and by a
   * manual rename (SessionManager.renameTitle) — both cases only need to
   * update local state and notify whoever is connected right now (e.g.
   * another device with this session open). Disk persistence is
   * SessionStore's responsibility, not this class's. */
  setTitle(title: string): void {
    this.title = title;
    this.broadcastTitle();
  }

  /** Only allowed before the first turn (see `runTurn`) — the caller
   * (server.ts) already handles the `ok: false` case by sending an error
   * only to the client that asked, not a broadcast. */
  setCwd(path: string): SetCwdResult {
    if (this.locked) return { ok: false, error: "locked" };
    const check = checkDirectory(path);
    if (!check.ok) return { ok: false, error: check.error };
    this.cwd = check.path;
    this.options.onCwdChange?.(this.cwd);
    this.broadcastCwdState();
    return { ok: true };
  }

  /** Called by `SessionManager` (via
   * `BackgroundJobTracker.onChanged`) whenever this session's list of
   * watched `anywh-bg` jobs changes. Same pattern as
   * `setTitle`/`setPermissionMode`: updates local state and notifies
   * whoever is connected right now. */
  setBackgroundJobs(jobs: WatchedJob[]): void {
    this.backgroundJobs = jobs.map(toBackgroundJobSummary);
    this.broadcastBackgroundJobs();
  }

  /** Cancellation request coming from the UI (the
   * `ChatPanel` chip). Pure passthrough to `SessionManager`;
   * `setBackgroundJobs` (called by it via the tracker's `onChanged`)
   * already takes care of telling clients the job disappeared from the
   * list — nothing extra needed here. */
  cancelBackgroundJob(jobId: string): void {
    this.options.onCancelBackgroundJob?.(jobId);
  }

  /** Thin delegation to `choiceMachine` — see `ChoiceMachine.presentChoice`
   * for the full reasoning. Kept as a method here (not inlined at call
   * sites) because it's called both from `runTurn`'s MCP bridge
   * registration and from the `plan`-mode marker fallback at its tail. */
  presentChoice(questions: ChoiceQuestion[]): boolean {
    return this.choiceMachine.presentChoice(questions);
  }

  /** Thin delegation to `choiceMachine` — see `ChoiceMachine.checkPermission`
   * for the full reasoning. Wired as the permission-prompt-tool bridge's
   * callback in `runTurn`'s `permissionRegistration`. */
  private checkPermission(toolName: string, input: unknown, toolUseId: string | undefined): Promise<PermissionDecision> {
    return this.choiceMachine.checkPermission(toolName, input, toolUseId);
  }

  /** The CLI reports its own permission-mode transitions
   * (e.g. right after approving `ExitPlanMode` mid-turn) via a
   * `{"type":"system","subtype":"status","permissionMode":...}` event,
   * observed immediately after the triggering `tool_use` and before its
   * `tool_result` (confirmed against the real binary). Without
   * this, the dropdown would keep showing the mode the human picked before
   * the turn started even though the CLI already moved on, AND the next
   * spawn's `--resume` would pass the stale mode again and silently undo
   * the transition. Guarded on an actual change so a turn with no mode
   * switch doesn't do redundant work on every status event; not
   * `setPermissionMode` (that one is for the human's own dropdown pick and
   * always notifies) because this needs the exact same side effects driven
   * by a different source of truth. */
  private applyPermissionModeFromCli(mode: string): void {
    if (!isPermissionMode(mode) || mode === this.permissionMode) return;
    this.permissionMode = mode;
    this.options.onPermissionModeChange?.(mode);
    this.broadcastPermissionMode();
  }

  /** Thin delegation — see `ChoiceMachine.cancelPendingApproval`. Called
   * unconditionally from `runTurn`'s `finally`, for any turn outcome. */
  private cancelPendingApproval(): void {
    this.choiceMachine.cancelPendingApproval();
  }

  /** Thin delegation — see `ChoiceMachine.discardStaleChoice`. Called from
   * the three sites where a human moves on without answering a deferred
   * choice: `submitTurn`, `editMessage`, `clearConversation`. */
  private discardStaleChoice(): void {
    this.choiceMachine.discardStaleChoice();
  }

  /** Called from the same three sites as `discardStaleChoice`
   * (`submitTurn`, `editMessage`, `clearConversation`): a wakeup a previous
   * turn's model armed for itself is stale the moment a real message (or a
   * fresh conversation) arrives first — firing it afterward would inject an
   * unrelated prompt into a conversation that has already moved on. Thin
   * passthrough to `SessionManager` (via `onCancelWakeup`), same reasoning as
   * `cancelBackgroundJob`: this class doesn't know the timer mechanism
   * exists, only that its intent no longer applies. */
  private cancelPendingWakeup(): void {
    this.options.onCancelWakeup?.();
  }

  /** Called from the WS handler (`server.ts`) when any connected device
   * answers. Delegates the state transition to `choiceMachine` (see
   * `ChoiceMachine.answerChoice` for the full reasoning on the two slots and
   * "first answer wins"), then acts on its `AnswerChoiceResult`: an
   * `"approval"` answer already resolved the blocked tool call inside
   * `choiceMachine` (the `claude` child spawned this turn is still alive
   * waiting for it) — nothing left to do here. A `"choice"` answer has no
   * call left to resolve (the turn that asked already ended, or ended
   * immediately after asking), so it's enqueued as an ordinary new turn
   * instead (`origin: undefined` — no client rendered a bubble for it
   * locally the way `submitTurn` callers do, so everyone connected needs the
   * synthetic `user_message` broadcast, not just "the others"). */
  answerChoice(promptId: string, answers: ChoiceAnswer[]): boolean {
    const result = this.choiceMachine.answerChoice(promptId, answers);
    if (result.kind === "not_found") return false;
    if (result.kind === "choice") {
      const text = formatPlanChoiceAnswerText(result.answers);
      this.turnQueue = this.turnQueue.then(() => this.runTurn(undefined, text));
    }
    return true;
  }

  addClient(socket: WebSocket): void {
    // First thing of all — a freshly opened tab knows the cwd/lock
    // immediately, without waiting for a turn or the history replay to finish.
    this.sendCwdState(socket);
    this.sendPermissionMode(socket);
    this.sendModelState(socket);
    if (this.title !== null) this.sendTitle(socket, this.title);
    this.sendContextUsage(socket);
    this.sendDraftState(socket);
    this.sendSuggestion(socket);
    this.sendTurnState(socket);
    this.sendBackgroundJobs(socket);
    this.choiceMachine.sendPendingTo(socket);

    this.ensureHistoryLoaded();
    // Only the recent tail (`INITIAL_HISTORY_TAIL_TURNS`
    // turns), not the whole `history`: long sessions (a real finding, "IVT
    // Fix" — 1670 reconstructed lines) used to stall the connection by
    // sending everything at once. The rest comes on demand via
    // `loadOlderHistory`, triggered by the user scrolling up in the UI. A
    // single message with the whole array (not one `send` per event) — this
    // is what lets the client hydrate the log with a single dispatch instead
    // of one per event (the reducer's O(n²) cost).
    const page = pageHistoryBefore(this.history, this.history.length, INITIAL_HISTORY_TAIL_TURNS);
    socket.send(JSON.stringify({ type: "history_page", messages: page.messages, cursor: page.cursor, hasMore: page.hasMore }));
    // Marks the end of the replay for this client — doesn't enter `history`
    // (it's not a session event, it's per-connection), so it's never resent
    // to the next clients that connect. This is what lets the client tell
    // apart a "turn_ended" from history reconstruction vs a real turn
    // that finished after it connected (relevant for OS notifications).
    socket.send(JSON.stringify({ type: "caught_up" }));
    this.clients.add(socket);
  }

  /** On-demand fetch of turns older than the tail sent
   * in `addClient`, triggered by the user scrolling up in the UI. Only
   * responds to the socket that asked: it's not a session event (doesn't
   * enter `history` again, it's already there), it's a one-off lookup for
   * one client. */
  loadOlderHistory(socket: WebSocket, beforeCursor: number): void {
    const page = pageHistoryBefore(this.history, beforeCursor, INITIAL_HISTORY_TAIL_TURNS);
    socket.send(JSON.stringify({ type: "older_history", messages: page.messages, cursor: page.cursor, hasMore: page.hasMore }));
  }

  removeClient(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  /** Called when the session is deleted (SessionManager.deleteSession) —
   * notifies whoever is connected right now (this tab, or another device
   * with the same session open) before closing the connection, to tell it
   * apart from a real network error. */
  closeAllClients(): void {
    for (const client of this.clients) {
      client.send(JSON.stringify({ type: "session_deleted" }));
      client.close();
    }
    this.clients.clear();
  }

  /**
   * `history` has always been in-memory only — it disappears on every relay
   * restart, even though Claude Code has the complete transcript on disk
   * (reconstructed from the `.jsonl` transcript, see `transcriptReader.ts`). Runs
   * once per process: once loaded, `history` is never empty again for this
   * session. Without `initialSessionId` there's nothing to read (new session).
   */
  private ensureHistoryLoaded(): void {
    if (this.history.length > 0 || this.historyCleared || !this.options.initialSessionId) return;
    const home = defaultCwd(this.homeOverride); // where the child process's ~/.claude/projects/ lives
    this.history.push(...readHistoryFromTranscript(home, this.cwd, this.options.initialSessionId));
  }

  /** `origin` is the socket that sent this message — used only to know who
   * already has the question bubble locally (the sender's `ChatPanel`
   * already committed it optimistically before calling this) so it doesn't
   * get duplicated by the synthetic `user_message` that `runTurn` broadcasts
   * to the OTHER devices connected to the same session (see comment there). */
  submitTurn(origin: WebSocket, text: string): void {
    // A previous turn's suggestion no longer applies once a new one starts —
    // clear it right away (don't wait for the turn to finish) so it doesn't
    // stay hanging around for the whole duration of the turn in progress.
    this.clearSuggestion();
    // A deferred `pendingChoice` the human ignored in favor of typing a
    // normal message directly is now stale — dismiss it rather than leave
    // the card showing a question for a plan/tool call the conversation has
    // already moved past.
    this.discardStaleChoice();
    // Same reasoning for a wakeup a previous turn armed for itself — a real
    // message beat the timer to it.
    this.cancelPendingWakeup();
    // Enqueue: only one `claude -p` turn runs at a time in this session.
    this.turnQueue = this.turnQueue.then(() => this.runTurn(origin, text));
  }

  /** Fired by `BackgroundJobTracker` (via
   * `SessionManager`) when a job started with `anywh-bg` finishes AFTER
   * the original turn that launched it has already ended (the reason
   * `anywh-bg` exists: that turn's `claude -p` process has already died,
   * so there's no one left to notify the user on its own). Same queue
   * (`turnQueue`) that serializes `/clear` against real turns — never runs
   * in parallel with a user turn nor corrupts `session_id`/history out of
   * order. No `origin` (no client sent this) — `runTurn` broadcasts the
   * synthetic prompt to everyone connected, not just "to the others". */
  submitBackgroundJobResult(job: FinishedBackgroundJob): void {
    this.clearSuggestion();
    const text = buildBackgroundJobFollowupPrompt(job);
    this.turnQueue = this.turnQueue.then(() => this.runTurn(undefined, text, { label: job.label, kind: "background_job" }));
  }

  /** Fired by `WakeupScheduler` (via `SessionManager`) when a
   * `ScheduleWakeup` timer armed by a previous turn's model call fires. The
   * `claude -p` process that would have hosted that timer natively already
   * exited at the end of that turn (spawn-per-turn, `runtimes/README.md`),
   * so nothing re-injects `prompt` on its own — this is what does it
   * instead, on the relay's own long-lived process. Same queue (`turnQueue`)
   * as every other turn origin — never runs in parallel with a real turn nor
   * corrupts `session_id`/history out of order. Unlike
   * `submitBackgroundJobResult`, `prompt` isn't wrapped into a synthesized
   * instruction: it's the model's own text, delivered verbatim, since that's
   * exactly what the native tool would have re-injected had it run on a
   * long-lived process. No `origin`, same reasoning as
   * `submitBackgroundJobResult` — no client rendered a bubble for this
   * locally.
   *
   * Known limitation: a `<<autonomous-loop-dynamic>>` sentinel `prompt`
   * (used by an autonomous `/loop` with no explicit prompt) is delivered
   * literally, like any other text — the harness resolves that sentinel
   * back into the loop's real instructions "at fire time" inside the ORIGINAL
   * `claude -p` process, which no longer exists by the time this fires on a
   * brand new invocation. A `/loop` with an explicit user-supplied prompt
   * (the common case, and the one originally reported broken) is unaffected:
   * `prompt` is already literal text either way. */
  submitWakeup(prompt: string): void {
    this.clearSuggestion();
    this.turnQueue = this.turnQueue.then(() => this.runTurn(undefined, prompt, { kind: "wakeup" }));
  }

  /** Interrupts the turn in progress, if any — doesn't touch the queue
   * (queued turns, if they ever exist, continue normally afterward). */
  stopTurn(): void {
    this.claude.stop();
  }

  /**
   * Message edit: stop the current turn (if any) + cut the real
   * `.jsonl` at the edited message's point + run a new turn with the edited
   * text — automatic from this single call. Interrupts the turn BEFORE
   * enqueueing (not inside `performEdit`) to avoid waiting for the response
   * in progress to finish on its own; the queue (`turnQueue`, the same one
   * that already serializes normal turns and `/clear`) guarantees
   * `performEdit` only runs after that interrupted turn has genuinely
   * resolved — only at that point has the `claude -p` process actually
   * exited and the `.jsonl` has the complete write on disk
   * (`ClaudeSession.stop`, tested against the real binary: `SIGINT` always
   * exits before `sendTurn` resolves).
   */
  editMessage(origin: WebSocket, fromEnd: number, text: string): void {
    const target = findEditTarget(this.history, fromEnd);
    if (!target) {
      origin.send(JSON.stringify({ type: "edit_message_error", code: "not_found" satisfies EditMessageError }));
      return;
    }
    this.clearSuggestion();
    // `claude.stop()` below only unblocks a live `pendingApproval` (it's
    // tied to the turn being interrupted) — a deferred `pendingChoice`
    // outlives its turn and needs the same explicit dismissal as `submitTurn`.
    this.discardStaleChoice();
    this.cancelPendingWakeup();
    this.claude.stop();
    this.turnQueue = this.turnQueue.then(() => this.performEdit(origin, target, text));
  }

  /** Reuses the normal `runTurn` for the turn with the edited text — same
   * `user_message` broadcast to other devices (excluding `origin`, which
   * already optimistically self-truncated like a normal send), same
   * streaming, same `turn_ended`. Only what comes before (truncating the
   * real transcript + the in-memory `history` + notifying the OTHER
   * devices of the cut) is edit-specific. */
  private async performEdit(origin: WebSocket, target: EditTarget, text: string): Promise<void> {
    try {
      if (target.turnsBefore > 0) {
        const sessionId = this.claude.getSessionId();
        // No known session_id but with turns before the cut: only happens
        // if the very first real turn failed before any `result` (a
        // referenceable `.jsonl` never came to exist — see the comment on
        // `ClaudeSession.sendTurn`). In that case there's no file to
        // truncate; the next turn already goes out without `--resume`
        // anyway, so nothing happens here (correct behavior by omission,
        // not special-cased handling).
        if (sessionId) {
          const home = defaultCwd(this.homeOverride);
          const path = transcriptPath(home, this.cwd, sessionId);
          const newSessionId = forkTruncatedTranscript(path, target.turnsBefore);
          this.claude.setSessionId(newSessionId);
          this.options.onSessionIdChange?.(newSessionId);
        }
      } else {
        // Editing the very first message of the session — nothing left to
        // preserve in a new file, equivalent to a `/clear` followed by the
        // edited text.
        this.claude.resetSessionId();
        this.options.onSessionIdClear?.();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[relay] failed to truncate transcript for edit:", message);
      origin.send(JSON.stringify({ type: "edit_message_error", code: "truncate_failed" satisfies EditMessageError }));
      return;
    }

    this.history.length = target.cutIndex;
    this.contextUsage = undefined;
    this.broadcastContextUsageReset();

    // Syncs OTHER devices connected to this session to the truncated point
    // — `origin` doesn't receive this because it already optimistically
    // self-truncated before sending `edit_message` (same pattern as the
    // synthetic `user_message` in `runTurn`, which also skips `origin`).
    const page = pageHistoryBefore(this.history, this.history.length, INITIAL_HISTORY_TAIL_TURNS);
    const payload = JSON.stringify({ type: "history_truncated", messages: page.messages, cursor: page.cursor, hasMore: page.hasMore });
    for (const client of this.clients) {
      if (client !== origin) client.send(payload);
    }

    await this.runTurn(origin, text);
  }

  /** Resolves when there's no turn in progress (nor queued) in this session
   * — used by the relay's graceful shutdown (server.ts) to know when it's
   * safe to exit without interrupting anything mid-flight. `turnQueue`
   * never rejects (`runTurn` handles its own errors and never rethrows), so
   * it's fine to return it directly without a try/catch here. */
  waitForIdle(): Promise<void> {
    return this.turnQueue;
  }

  /** `/clear` — same queue as real turns (`turnQueue`), so it
   * never runs in parallel with a turn in progress and risks one of the
   * two overwriting the other's `session_id`/`history` out of order.
   * Doesn't touch permissionMode or model — only the conversation's CONTENT
   * resets, same as the CLI's real `/clear` (just without running any
   * process: see `ClaudeSession.resetSessionId`). The cwd IS unlocked,
   * unlike the CLI: with no history or `session_id` left, there's nothing
   * left tying the next turn to the old folder (see the comment about the
   * lock in `runTurn`), so the session can pick another one again, just
   * like a new session. */
  clearConversation(): void {
    this.discardStaleChoice();
    this.cancelPendingWakeup();
    this.turnQueue = this.turnQueue.then(() => {
      this.claude.resetSessionId();
      this.history.length = 0;
      this.historyCleared = true;
      this.contextUsage = undefined;
      this.options.onSessionIdClear?.();
      // Same reasoning as the session_id/history reset above: the title
      // described the conversation that no longer exists. Also rearms
      // `onFirstPrompt` so the next real message gets a fresh one
      // instead of it staying stuck on the old conversation's title forever.
      this.title = null;
      this.firstPromptSeeded = false;
      this.options.onTitleClear?.();
      if (this.locked) {
        this.locked = false;
        this.options.onUnlockChange?.();
        this.broadcastCwdState();
      }
      this.broadcastContextUsageReset();
      this.clearSuggestion();
      this.broadcastConversationReset();
    });
  }

  /** `origin` is `undefined` only for a synthetic turn — `submitBackgroundJobResult`
   * (an `anywh-bg` job's automatic follow-up) or `submitWakeup` (a
   * `ScheduleWakeup` timer firing) — no specific client "already has the
   * bubble locally" in that case, so the synthetic prompt goes to
   * everyone, and the cwd/title lock (only makes sense for the FIRST real
   * turn of the session, which by definition already happened before either
   * kind of synthetic turn could exist) is skipped. `label` is only
   * meaningful for `"background_job"` (the client shows it in the system
   * note); a wakeup's note carries no per-instance label. */
  private async runTurn(
    origin: WebSocket | undefined,
    text: string,
    synthetic?: { label?: string; kind: "background_job" | "wakeup" },
  ): Promise<void> {
    this.options.onActivity?.();

    // A turn in progress is "current" state (same reasoning as
    // cwd/permission/model), not a `history` event — a real finding from
    // testing multi-device: without this, only whoever sent the message saw
    // the "thinking"/timer indicator (`TurnIndicator`), because the
    // client's `turnInFlight` only turns on optimistically for whoever
    // clicked "Send". `startedAt` (not just a boolean) lets another
    // device's timer — or a third device connecting mid-turn — count from
    // the real start, not from when it found out.
    this.turnStartedAt = Date.now();
    this.broadcastTurnState();

    // First thing in the log for this turn — see `AgentEvent`'s own doc
    // comment on why this (and `turn_ended` below) are synthesized here
    // rather than mapped from anything the CLI emits. Sent to every device,
    // origin included: unlike `user_message` below, no device has already
    // rendered this locally.
    this.broadcast({ type: "agent_event", event: { type: "turn_started" } });

    // Syncs the question to the OTHER devices connected to this same
    // session — a real finding: without this, whoever didn't send the
    // message would see the assistant's response appear live without the
    // question that prompted it (the protocol never carried the user's
    // text, only the events the CLI emits afterward). Same synthetic format
    // that `transcriptReader.ts` already uses for the replay reconstructed
    // from disk. Doesn't send to `origin`: whoever sent it
    // already committed the bubble locally optimistically (`ChatPanel`),
    // getting it back would duplicate it.
    {
      const event: AgentEvent = synthetic
        ? { type: "user_message", text, synthetic: synthetic.kind, ...(synthetic.label ? { label: synthetic.label } : {}) }
        : { type: "user_message", text };
      if (origin) {
        this.broadcastExcept({ type: "agent_event", event }, origin);
      } else {
        this.broadcast({ type: "agent_event", event });
      }
    }

    if (!synthetic) {
      // Locks the folder at the exact moment of the first real turn — not
      // at the WS connection (which already happens before any message)
      // nor in `submitTurn` (avoids a race between two `submitTurn` calls
      // in sequence before the first one dequeues). The session_id this
      // turn may generate gets tied to the current `this.cwd` so
      // `--resume` works later.
      if (!this.locked) {
        this.locked = true;
        this.options.onLockChange?.();
        this.broadcastCwdState();
      }
      // Commands (`/clear`, `/model` etc) don't count as a real
      // first prompt for the title — generation only runs once the first
      // message that doesn't start with "/" arrives, even if it's not the
      // session's first turn. A synthetic turn never counts (it's not
      // "the first message" from anyone, and the session has had a title
      // for a while already if a job had time to run and finish).
      if (!this.firstPromptSeeded && !text.trim().startsWith("/")) {
        this.firstPromptSeeded = true;
        this.options.onFirstPrompt?.(text);
      }
    }

    // Registered fresh for every turn (not once per session):
    // the token is the endpoint's only auth, and a turn that ends (however
    // it ends — success, error, or `stopTurn`) must not leave a token alive
    // that a since-exited `claude` child could no longer call anyway. Only
    // built outside `plan` mode: the CLI blocks any non-native tool
    // categorically there regardless of `--allowedTools` — passing this
    // would be dead weight on every spawn.
    const choiceRegistration =
      this.options.mcpChoiceBridge && this.permissionMode !== "plan"
        ? this.options.mcpChoiceBridge.registerTurn({ presentChoice: (questions) => this.presentChoice(questions) })
        : undefined;
    // Only skipped in `bypassPermissions`, the one mode
    // whose entire point is "don't ask". Merged below with
    // `choiceRegistration` into a single `--mcp-config` when both are active
    // (every mode except `bypassPermissions` — `plan` only gets this one,
    // `default`/`acceptEdits` get both): validated against the real binary
    // that `--allowedTools` and `--permission-prompt-tool` coexist fine in
    // the same spawn, so there's no need to pick one over the other here.
    const permissionRegistration =
      this.options.mcpPermissionBridge && this.permissionMode !== "bypassPermissions"
        ? this.options.mcpPermissionBridge.registerTurn({
            checkPermission: (toolName, input, toolUseId) => this.checkPermission(toolName, input, toolUseId),
          })
        : undefined;
    // The actual CLI-arg assembly (which servers, which flags, the known-
    // ineffective idle-timeout override, the alwaysLoad fix) is pure and
    // lives in `buildMcpSpawnConfig` (turnMessages.ts) — see its doc comment
    // for the full reasoning. This is only the "which mode gets which
    // bridge" decision, which needs `this.permissionMode` and stays here.
    const mcp = buildMcpSpawnConfig({
      choiceToken: choiceRegistration?.token,
      permissionToken: permissionRegistration?.token,
      mcpBridgeBaseUrl: this.options.mcpBridgeBaseUrl,
      mcpPermissionBridgeBaseUrl: this.options.mcpPermissionBridgeBaseUrl,
      // `choiceRegistration !== undefined` mirrors today's `choiceToken`
      // truthiness (present_choice registered as AskUserQuestion's
      // replacement); `permissionMode === "plan"` is the extra case where
      // present_choice can't be registered (the CLI blocks it there) but the
      // native tool still needs blocking so the model falls back to the
      // plan-mode text-marker convention instead of a dead tool call. The two
      // clauses are mutually exclusive given `choiceRegistration`'s own
      // `permissionMode !== "plan"` gate above, but left as an OR so this
      // stays correct if that gate ever changes.
      blockAskUserQuestion: this.permissionMode === "plan" || choiceRegistration !== undefined,
    });

    // Hoisted out of the `try` below so the plan-mode marker check after it
    // can see the turn's outcome — needs to run AFTER the `finally` block,
    // not before: `finally`'s `cancelPendingApproval` only ever touches
    // `pendingApproval` (never `pendingChoice`, see that method's doc
    // comment), so ordering relative to it doesn't actually matter anymore
    // for THIS specific prompt the way it used to pre-rework — kept in this
    // position regardless, since the turn's outcome (`stopped`,
    // `lastAssistantText`) genuinely isn't known until `sendTurn` resolves.
    let turnStopped = false;
    let planChoiceText: string | undefined;
    try {
      const { stopped, contextUsage, lastAssistantText } = await this.claude.sendTurn(
        text,
        this.cwd,
        this.permissionMode,
        this.model,
        (event) => {
          for (const agentEvent of mapClaudeEvent(event)) {
            // Must run BEFORE the broadcast below: a device reconnecting
            // mid-turn right as this arrives should see the updated mode,
            // not a stale one from before this same event was processed.
            // Checked unconditionally (not just when `permissionRegistration`
            // is active) since this is a general CLI mechanism, not
            // exclusive to the `ExitPlanMode` path. Reads the already-mapped
            // `status` event rather than peeking at the raw CLI line
            // separately — both used to exist side by side, one only ever a
            // step behind the other since they're produced from the exact
            // same raw event.
            if (agentEvent.type === "status" && agentEvent.permissionMode !== undefined) {
              this.applyPermissionModeFromCli(agentEvent.permissionMode);
            }
            this.broadcast({ type: "agent_event", event: agentEvent });
            // Lets the `anywh-bg` job tracker (owned by
            // `SessionManager`) see every event of every turn, looking for
            // the start marker. Purely observational: never throws nor
            // alters the turn's flow.
            this.options.onEvent?.(agentEvent);
          }
        },
        mcp,
      );
      turnStopped = stopped;
      planChoiceText = lastAssistantText;
      const sessionId = this.claude.getSessionId();
      if (sessionId) this.options.onSessionIdChange?.(sessionId);
      if (contextUsage) {
        this.contextUsage = contextUsage;
        this.options.onContextUsageChange?.(contextUsage);
        this.broadcastContextUsage();
      }
      this.broadcast({ type: "agent_event", event: { type: "turn_ended", stopped } });
      // Only suggests a follow-up for a turn that genuinely finished (not
      // interrupted) — fire-and-forget, doesn't delay `turn_ended`
      // above. Speed isn't a priority here (it's a convenience, not part
      // of the main flow), so no timeout/cancellation is needed. A
      // synthetic turn (`synthetic`) never suggests: the "user text" that
      // would feed the generator is the follow-up's internal instruction,
      // not something that makes sense to offer as a real next message.
      if (!stopped && !synthetic) {
        generateSuggestion(this.homeOverride, this.cwd, text, lastAssistantText)
          .then((suggestion) => {
            this.suggestion = suggestion ?? null;
            this.options.onSuggestionChange?.(this.suggestion);
            this.broadcastSuggestion();
          })
          .catch((error: unknown) => {
            console.error("[relay] failed to generate next-message suggestion:", error);
          });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[relay] turn failed:", message);
      this.broadcast({ type: "agent_event", event: { type: "error", message } });
    } finally {
      choiceRegistration?.unregister();
      permissionRegistration?.unregister();
      // Only `pendingApproval` — `pendingChoice` deliberately survives the
      // turn that created it (see the doc
      // comment on `cancelPendingApproval`). This is THE inversion this
      // feature made: before it, this line cleared BOTH kinds
      // unconditionally, which is exactly why the `"planText"` prompt (the
      // plan-mode marker below) always had to be created AFTER this
      // `finally` ran — otherwise this same cleanup would have wiped it out
      // the instant it was created. `present_choice` now needs that same
      // survival property, which is what motivated splitting the field.
      this.cancelPendingApproval();
      this.turnStartedAt = null;
      this.broadcastTurnState();
    }

    // Plan mode's `present_choice` fallback: that mode never gets
    // the MCP tool at all (`choiceRegistration` above is skipped for it), so
    // a genuinely closed question only shows up as a text marker in the
    // final response. Checked here, after the turn (and its `finally`
    // cleanup) has fully finished, not inside the `try` — see the comment
    // on `turnStopped`/`planChoiceText`. Goes through the same `presentChoice`
    // the MCP tool uses (not a separate method anymore): both origins feed
    // the same deferred `pendingChoice` slot now, so there's no reason for
    // two publish paths. The acceptance check inside `presentChoice` is a
    // no-op here in practice — plan mode never registers the `present_choice`
    // MCP tool (`choiceRegistration` above), so nothing else could have set
    // `pendingChoice` for this same turn to collide with.
    if (!turnStopped && !synthetic && this.permissionMode === "plan" && planChoiceText) {
      const questions = parsePlanChoiceMarkers(planChoiceText);
      if (questions.length > 0) this.presentChoice(questions);
    }
  }

  private sendBackgroundJobs(target: WebSocket): void {
    sendBackgroundJobs(target, this.backgroundJobs);
  }

  private broadcastBackgroundJobs(): void {
    broadcastBackgroundJobs(this.clients, this.backgroundJobs);
  }

  private sendTurnState(target: WebSocket): void {
    sendTurnState(target, this.turnStartedAt);
  }

  private broadcastTurnState(): void {
    broadcastTurnState(this.clients, this.turnStartedAt);
  }

  private sendCwdState(target: WebSocket): void {
    sendCwdState(target, this.cwd, this.locked);
  }

  private broadcastCwdState(): void {
    broadcastCwdState(this.clients, this.cwd, this.locked);
  }

  private sendPermissionMode(target: WebSocket): void {
    sendPermissionMode(target, this.permissionMode);
  }

  private broadcastPermissionMode(): void {
    broadcastPermissionMode(this.clients, this.permissionMode);
  }

  private sendModelState(target: WebSocket): void {
    sendModelState(target, this.model);
  }

  private broadcastModelState(): void {
    broadcastModelState(this.clients, this.model);
  }

  private sendDraftState(target: WebSocket): void {
    sendDraftState(target, this.draft);
  }

  private broadcastDraftState(): void {
    broadcastDraftState(this.clients, this.draft);
  }

  private sendContextUsage(target: WebSocket): void {
    sendContextUsage(target, this.contextUsage);
  }

  private broadcastContextUsage(): void {
    broadcastContextUsage(this.clients, this.contextUsage);
  }

  private broadcastContextUsageReset(): void {
    broadcastContextUsageReset(this.clients);
  }

  private broadcastConversationReset(): void {
    broadcastConversationReset(this.clients);
  }

  private sendSuggestion(target: WebSocket): void {
    sendSuggestion(target, this.suggestion);
  }

  private broadcastSuggestion(): void {
    broadcastSuggestion(this.clients, this.suggestion);
  }

  private clearSuggestion(): void {
    if (this.suggestion === null) return;
    this.suggestion = null;
    this.options.onSuggestionChange?.(null);
    this.broadcastSuggestion();
  }

  private sendTitle(target: WebSocket, title: string): void {
    sendTitle(target, title);
  }

  private broadcastTitle(): void {
    broadcastTitle(this.clients, this.title);
  }

  private broadcast(message: BroadcastMessage): void {
    broadcast(this.clients, this.history, message);
  }

  private broadcastExcept(message: BroadcastMessage, exclude: WebSocket): void {
    broadcastExcept(this.clients, this.history, message, exclude);
  }
}
