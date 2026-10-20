import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { type ChoiceAnswer, type ChoiceQuestion } from "../bridges/mcpBridge.js";
import type { ChoicePrompt, DeferredToolCall, PersistedApproval, PersistedChoice } from "./sessionStore.js";
import { broadcastChoicePrompt, broadcastChoiceResolved, sendChoicePrompt } from "./broadcast.js";

/** What `answerChoice` resolved, told apart so `SharedSession` (the only
 * caller with a `turnQueue`/`runTurn` to act on it) knows what side effect
 * to run — this class doesn't know about turns, sessions, or Claude at all,
 * on purpose: it's the piece Fase 10 reuses for the Codex approval bridge
 * without going through `permissionBridge.ts`. */
export type AnswerChoiceResult =
  | { kind: "not_found" }
  | { kind: "approval" }
  | { kind: "choice"; answers: ChoiceAnswer[] }
  /** The held-back tool calls of a deferred approval, with the answers in
   * the same order (`answers[i]` is about `calls[i]`). */
  | { kind: "deferredApproval"; calls: DeferredToolCall[]; questions: ChoiceQuestion[]; answers: ChoiceAnswer[] };

/** Where the deferred-approval slot is rehydrated from and mirrored to. */
export interface DeferredApprovalStorage {
  /** A deferred approval persisted before a relay restart, if any. */
  initial?: PersistedApproval;
  /** Fires whenever the slot is set or emptied (`undefined`). */
  onChange?: (approval: PersistedApproval | undefined) => void;
  /** Refused calls waiting behind an approval card that is on screen. */
  initialQueued?: PersistedApproval;
  onQueuedChange?: (approval: PersistedApproval | undefined) => void;
  /** An approval was withdrawn without the model being told. */
  initialWithdrawn?: boolean;
  onWithdrawnChange?: (withdrawn: boolean) => void;
}

/**
 * Owns the pending-question slots a session can have open at once.
 * Two SEPARATE slots, not one
 * discriminated union anymore. They used to share a single field (told
 * apart by a `kind: "mcp" | "planText"` tag) because both were "a question
 * waiting for a human" — but they now have genuinely incompatible
 * lifecycles, and a model that calls `present_choice` and then keeps
 * working in the same turn (an accepted, if degraded, outcome — see
 * `presentChoice` below) can make BOTH exist at once for the same turn:
 * `present_choice` publishes into `pendingChoice` and returns immediately,
 * which doesn't stop the model from then calling e.g. `Write`, which
 * triggers a REAL `checkPermission` approval into `pendingApproval`. One
 * shared slot would force one of the two to silently clobber the other's
 * UI; separate fields don't.
 *
 * `pendingApproval` backs `--permission-prompt-tool`
 * (`SharedSession.checkPermission`/`presentApprovalChoice`) and stays BLOCKING on
 * purpose: the CLI itself is paused mid-turn waiting for exactly this HTTP
 * response to decide whether to run a tool call — there's no "answer
 * arrives as a later turn" option for it, so `SharedSession.runTurn`'s
 * `finally` must still force-resolve it via `cancelPendingApproval` no
 * matter how the turn ends (success, error, `stopTurn`/SIGINT).
 *
 * `pendingChoice` backs the model-facing `present_choice` tool AND the
 * `plan`-mode text-marker fallback (`planChoiceMarker.ts`) — both are
 * DEFERRED: the turn that asked has already ended, or ends right away
 * (`presentChoice` replies to the tool call immediately, see
 * `mcpBridge.ts`'s `ChoiceHost`), by the time a human answers, so the
 * answer becomes a brand new turn instead of resolving anything in flight.
 * This is the field whose lifecycle INVERTED with this feature: it used to
 * be force-cleared by `runTurn`'s `finally` same as `pendingApproval` still
 * is; now it must survive the turn that created it, on purpose — cleared
 * only by `answerChoice` (human answered) or `discardStaleChoice` (human
 * moved on without answering: new message, edit, `/clear`).
 *
 * A third slot, `deferredApproval`, is the non-blocking form of
 * `pendingApproval` for sessions that turned deferral on: the tool call was
 * already refused on the spot (the turn ends, no child and no HTTP call is
 * left waiting), and the human's verdict arrives later as a new turn, exactly
 * like `pendingChoice`. It has the same lifecycle as `pendingChoice`
 * (persisted, rehydrated, cleared by an answer or by the human moving on) and
 * holds one entry per refused call of the turn, published as one prompt.
 *
 * `pendingApproval` is in-memory only: on a relay restart there's nothing
 * meaningful left to resume for it (its underlying `claude` child dies too,
 * see `McpChoiceBridge`'s per-turn `unregister`). `pendingChoice` is
 * mirrored into the session store (`onChoiceChange`) and rehydrated through
 * `initialChoice`, because it can sit unanswered for days and a restart must
 * not make it vanish.
 */
export class ChoiceMachine {
  private pendingApproval: (ChoicePrompt & { resolve: (answers: ChoiceAnswer[]) => void }) | undefined;
  private pendingChoice: PersistedChoice | undefined;
  private deferredApproval: PersistedApproval | undefined;
  /** Calls refused during the running turn, not yet a card: the card is
   * published once, when the turn ends (`flushDeferredApprovals`). Not
   * persisted — a turn that dies with the relay has nothing to ask about. */
  private staged: Array<{ call: DeferredToolCall; question: ChoiceQuestion; turnId: number }> = [];
  /** Refused calls that arrived while an approval card was on screen: they
   * become the next card once it is answered. Persisted. */
  private queued: PersistedApproval | undefined;
  private withdrawn: boolean;
  /** Deferrals from turns up to this one are ignored: the person moved on
   * while they were running. */
  private ignoreUpTo = 0;
  /** Which deferred card a person is looking at. At most one of the two
   * deferred slots is on screen; the other waits, already persisted, and
   * appears when this one is resolved (the client shows one card at a time,
   * so a second would hide the first until a reconnect). */
  private active: "choice" | "approval" | undefined;

  /** `onPromptShown` fires once each time a prompt is published, so the
   * session can tell a person who isn't looking that one is waiting. */
  constructor(
    private readonly clients: Set<WebSocket>,
    private readonly onPromptShown?: (kind: "approval" | "choice", questions: ChoiceQuestion[]) => void,
    /** A deferred question persisted before a relay restart, if any. */
    initialChoice?: PersistedChoice,
    /** Fires whenever the deferred slot is set (the prompt) or emptied
     * (`undefined`), so the session can mirror it into the store. */
    private readonly onChoiceChange?: (choice: PersistedChoice | undefined) => void,
    /** Injectable clock (epoch ms) for `askedAt`. */
    private readonly now: () => number = Date.now,
    private readonly deferredStorage: DeferredApprovalStorage = {},
  ) {
    this.pendingChoice = initialChoice;
    this.deferredApproval = deferredStorage.initial;
    this.queued = deferredStorage.initialQueued;
    this.withdrawn = deferredStorage.initialWithdrawn === true;
    // Waiting calls with no card to wait behind (a hand-edited file) simply
    // become the card.
    if (!this.deferredApproval && this.queued) {
      this.deferredApproval = this.queued;
      this.queued = undefined;
    }
    this.active = initialChoice ? "choice" : this.deferredApproval ? "approval" : undefined;
  }

  /** Mirrors a deferred slot into the store. Always runs AFTER the
   * in-memory transition and the broadcast, and never throws: the write is
   * sync (`writeFileSync`) and can fail (disk full, read-only file), which
   * must cost at most a stale record on disk — not the user's answer, the
   * dismissal of the card, or the model's tool call. */
  private mirror(choice: PersistedChoice | undefined): void {
    this.mirrorWith(() => this.onChoiceChange?.(choice), "choice");
  }

  private mirrorApproval(approval: PersistedApproval | undefined): void {
    this.mirrorWith(() => this.deferredStorage.onChange?.(approval), "approval");
  }

  private mirrorQueued(approval: PersistedApproval | undefined): void {
    this.mirrorWith(() => this.deferredStorage.onQueuedChange?.(approval), "queued approval");
  }

  private setWithdrawn(value: boolean): void {
    if (this.withdrawn === value) return;
    this.withdrawn = value;
    this.mirrorWith(() => this.deferredStorage.onWithdrawnChange?.(value), "withdrawal mark");
  }

  /** Whether an approval was withdrawn without the model being told; reading
   * it clears it, so exactly one message carries the note. */
  takeWithdrawn(): boolean {
    const was = this.withdrawn;
    this.setWithdrawn(false);
    return was;
  }

  private mirrorWith(write: () => void, what: string): void {
    // One retry: a failed CLEAR leaves the old question on disk, and after a
    // restart an answered question would come back. (The store's in-memory
    // records are already updated, so any later successful write of the
    // file fixes it too.)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        write();
        return;
      } catch (error) {
        if (attempt === 2) console.error(`[relay] could not persist the pending ${what}:`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Drops a question adopted from the store that turns out to belong to no
   * conversation (see `SharedSession`'s constructor). Silent: nothing was
   * shown to anyone yet. Only the stored copy needs clearing. */
  dropRehydrated(): void {
    if (this.pendingChoice) {
      this.pendingChoice = undefined;
      this.mirror(undefined);
    }
    if (this.deferredApproval) {
      this.deferredApproval = undefined;
      this.mirrorApproval(undefined);
    }
    if (this.queued) {
      this.queued = undefined;
      this.mirrorQueued(undefined);
    }
    this.setWithdrawn(false);
    this.active = undefined;
  }

  /** Called by the MCP bridge
   * (`McpChoiceBridge`, `ChoiceHost.presentChoice`) when the model calls
   * `present_choice`. Used to return a `Promise<ChoiceAnswer[]>` and hold the
   * tool call open until `answerChoice` resolved it — abandoned because a
   * human reading a prompt on their phone can take arbitrarily long, and a
   * held-open `tools/call` ties the answer to a live `claude` child. Now
   * synchronous: publishes the prompt and
   * returns immediately, `true` if accepted. `McpChoiceBridge.handleRequest`
   * turns that into the tool's `tool_result` (an instruction to end the
   * turn, see `CHOICE_DEFERRED_RESPONSE_TEXT`) — the eventual human answer
   * becomes a brand new turn instead (`answerChoice` below), exactly like
   * the `plan`-mode text-marker fallback always had to work.
   *
   * Returns `false` without touching `pendingChoice` if one is already
   * pending — only one at a time (same invariant this always had), enforced
   * explicitly now that a slow human can't be told apart from "the model
   * called this again before ending its turn" by anything other than this
   * check (the old blocking version didn't need this: a turn only ever has
   * one tool call in flight, so a second `present_choice` literally couldn't
   * arrive before the first resolved). Called directly (no separate wrapper
   * anymore) by the `plan`-mode marker path at the tail of `runTurn` too —
   * that path can't practically collide with this one (plan mode never
   * registers the `present_choice` MCP tool at all, `choiceRegistration` in
   * `runTurn`), but routing both through the same function keeps that
   * invariant enforced in one place instead of two. */
  presentChoice(questions: ChoiceQuestion[]): boolean {
    if (this.pendingChoice) return false;
    const promptId = randomUUID();
    this.pendingChoice = { promptId, questions, askedAt: this.now() };
    this.mirror(this.pendingChoice);
    this.publishNext();
    return true;
  }

  /** The permission-approval counterpart to
   * `presentChoice`, kept BLOCKING on purpose: `--permission-prompt-tool`
   * calls stay open in `McpPermissionBridge` (`permissionBridge.ts`) because
   * the CLI itself is paused mid-turn waiting for a verdict to decide
   * whether to run the pending tool call — there's no "answer arrives as a
   * later turn" for that, the decision has to come back as the result of
   * THIS call, same as it always did before this feature existed (this is
   * the old shared `presentChoice`, renamed and given its own `pendingApproval`
   * slot now that the model-facing tool it used to share a field with no
   * longer blocks — see the class doc comment above for why they needed to
   * split). Only one at a time can be pending: a turn is a single
   * `claude -p` process handling one tool call at a time, so there's no
   * scenario where a second call would arrive before this one resolves —
   * unlike `presentChoice`, no acceptance check is needed here. The
   * returned promise only settles from `answerChoice` below — genuinely
   * unbounded wait, by design (matches how the real interactive CLI already
   * behaves; the CLI's own cut of a pending MCP call is overridden by the
   * per-server `timeout` in `--mcp-config`, see `buildMcpSpawnConfig`).
   * Every lifecycle path
   * that could leave this dangling — client disconnect, session delete,
   * relay shutdown — resolves through the SAME turn-in-progress machinery
   * `stopTurn`/`waitForIdle` use, via `cancelPendingApproval` in `runTurn`'s
   * `finally`.
   *
   * Public (used to be private, called only from this class's own
   * `checkPermission`) — that method moved to `SharedSession`, which is the
   * only place that knows what a Claude `--permission-prompt-tool` call
   * needs to become a `ChoiceQuestion` in the first place
   * (`buildApprovalQuestion`, Claude-CLI-shaped). This class stays generic:
   * a slot lifecycle for "a yes/no question a human has to answer before a
   * blocked action can proceed," reusable by any def whose approval is
   * native rather than bridged (Fase 10's Codex driver, via `TurnHost`). */
  presentApprovalChoice(questions: ChoiceQuestion[]): Promise<ChoiceAnswer[]> {
    return new Promise((resolve) => {
      const promptId = randomUUID();
      this.pendingApproval = { promptId, questions, askedAt: this.now(), resolve };
      broadcastChoicePrompt(this.clients, this.pendingApproval, "approval");
      this.onPromptShown?.("approval", questions);
    });
  }

  /** The non-blocking counterpart of `presentApprovalChoice`: the caller has
   * ALREADY refused `call` (the CLI got its answer and the turn will end), so
   * this only records that a human still has to say yes or no, and returns at
   * once — no promise, nothing for `cancelPendingApproval` to settle. The
   * verdict comes back through `answerChoice` as a `deferredApproval` result.
   *
   * A model that issues several tool calls before it notices the refusal
   * produces several of these during one turn. They are only staged here; the
   * card is published once, with a stable id, by `flushDeferredApprovals` when
   * the turn ends — republishing per call would reset the person's progress
   * through the card. A repeat of a `toolUseId` already held is ignored. */
  deferApproval(call: DeferredToolCall, question: ChoiceQuestion, turnId: number): void {
    if (turnId <= this.ignoreUpTo) return;
    if (call.toolUseId !== undefined) {
      const known = (other: DeferredToolCall): boolean => other.toolUseId === call.toolUseId;
      if (this.staged.some((entry) => known(entry.call)) || this.deferredApproval?.calls.some(known) || this.queued?.calls.some(known)) return;
    }
    this.staged.push({ call, question, turnId });
  }

  /** Turns what the finished turn `turnId` staged into the pending approval
   * (persisted) and shows it unless another card is on screen. Calls that
   * arrive while an approval card is on screen wait, persisted, for the next
   * cycle: they become a new card once that one is answered. */
  flushDeferredApprovals(turnId: number): void {
    const mine = this.staged.filter((entry) => entry.turnId === turnId);
    if (mine.length === 0) return;
    this.staged = this.staged.filter((entry) => entry.turnId !== turnId);
    const add = (held: PersistedApproval | undefined): PersistedApproval => ({
      promptId: held?.promptId ?? randomUUID(),
      questions: [...(held?.questions ?? []), ...mine.map((entry) => entry.question)],
      calls: [...(held?.calls ?? []), ...mine.map((entry) => entry.call)],
      askedAt: held?.askedAt ?? this.now(),
    });
    if (this.deferredApproval && this.active === "approval") {
      this.queued = add(this.queued);
      this.mirrorQueued(this.queued);
      return;
    }
    this.deferredApproval = add(this.deferredApproval);
    this.mirrorApproval(this.deferredApproval);
    this.publishNext();
  }

  /** A stopped turn's refusals are not worth asking about: the person
   * interrupted the work they belonged to. Only that turn's are dropped. The
   * model did hear "wait for approval", so the next message must say it was
   * withdrawn. Returns whether anything was dropped. */
  dropStagedApprovals(turnId: number): boolean {
    const before = this.staged.length;
    this.staged = this.staged.filter((entry) => entry.turnId !== turnId);
    const dropped = this.staged.length < before;
    if (dropped) this.setWithdrawn(true);
    return dropped;
  }

  /** Shows the next waiting deferred card if none is on screen: a question
   * first, then an approval (the queue behind a finished approval card
   * included). */
  private publishNext(): void {
    if (this.active) return;
    if (this.pendingChoice) {
      this.active = "choice";
      broadcastChoicePrompt(this.clients, this.pendingChoice, "choice");
      this.onPromptShown?.("choice", this.pendingChoice.questions);
      return;
    }
    if (!this.deferredApproval && this.queued) {
      this.deferredApproval = this.queued;
      this.queued = undefined;
      this.mirrorQueued(undefined);
      this.mirrorApproval(this.deferredApproval);
    }
    if (this.deferredApproval) {
      this.active = "approval";
      broadcastChoicePrompt(this.clients, this.deferredApproval, "approval");
      this.onPromptShown?.("approval", this.deferredApproval.questions.slice(0, 1));
    }
  }

  /** Whatever's left pending in `pendingApproval` when a turn ends, for ANY
   * reason (normal completion, error, or `stopTurn`/SIGINT — `runTurn`'s
   * `finally` calls this unconditionally), must be force-resolved: the
   * `claude` child that would have received the answer no longer exists by
   * the time this runs (`sendTurn`'s promise only resolves after the
   * child's `close` event), so the actual answer content is moot — but
   * without this, `pendingApproval` would linger forever (a reconnecting
   * device would see an approval card for a conversation that will never
   * continue), and the `await` inside `McpPermissionBridge.handleRequest`
   * for that call would never settle (`unregister` only removes it from
   * future lookups, it doesn't reach into an already-in-flight call).
   *
   * Deliberately does NOT touch `pendingChoice` — that's the entire point of
   * this feature: a `present_choice`/plan-marker
   * prompt must survive the turn that created it, precisely so a slow human
   * can still answer it after the turn (and the `claude` child that asked)
   * is long gone. See the class doc comment above for the full reasoning on
   * why they're two fields now instead of one union cleared by a single
   * function (the old `cancelPendingChoice`, pre-rework, cleared both kinds
   * here). */
  cancelPendingApproval(): void {
    if (!this.pendingApproval) return;
    const pending = this.pendingApproval;
    this.pendingApproval = undefined;
    broadcastChoiceResolved(this.clients, pending.promptId);
    pending.resolve([]);
  }

  /** `pendingChoice` outlives the turn that created it by design (unlike
   * `pendingApproval`, cleaned up by `cancelPendingApproval` as soon as its
   * turn ends, one way or another). If the human moves on without answering
   * it — sends a new message directly, edits an earlier one, or clears the
   * conversation — the stale card needs this explicit dismissal, called from
   * those exact three sites (in `SharedSession`), or it would keep showing a
   * question for a conversation that has already moved past it. Covers both
   * origins that feed `pendingChoice` (the MCP `present_choice` tool and the
   * `plan`-mode text marker) uniformly — from here on they're
   * indistinguishable, both just "a deferred prompt nobody answered yet". */
  discardStaleChoice(currentTurnId: number): boolean {
    const hadStaged = this.staged.length > 0;
    this.staged = [];
    // Refusals still to come from a turn that is running right now belong to
    // a conversation the person has left.
    this.ignoreUpTo = Math.max(this.ignoreUpTo, currentTurnId);
    const hadQueued = this.queued !== undefined;
    if (this.queued) {
      this.queued = undefined;
      this.mirrorQueued(undefined);
    }
    if (this.pendingChoice) {
      const { promptId } = this.pendingChoice;
      this.pendingChoice = undefined;
      broadcastChoiceResolved(this.clients, promptId);
      this.mirror(undefined);
    }
    // A deferred approval is the same kind of leftover: the refused call
    // belongs to a conversation the human has now moved past.
    const withdrawn = this.deferredApproval !== undefined || hadStaged || hadQueued;
    if (this.deferredApproval) {
      const { promptId } = this.deferredApproval;
      this.deferredApproval = undefined;
      broadcastChoiceResolved(this.clients, promptId);
      this.mirrorApproval(undefined);
    }
    this.active = undefined;
    return withdrawn;
  }

  /** Called from the WS handler (`server.ts`) when any connected device
   * answers. Checks `pendingApproval` first, then `pendingChoice` — a
   * `promptId` only ever matches one of the two (they're independent random
   * UUIDs), the order just picks which lookup happens first.
   * "First answer wins" applies to each
   * slot independently: once resolved, that slot is cleared immediately, so
   * a second device racing to answer the same prompt simply gets a
   * `{ kind: "not_found" }` back (its answer is a no-op) instead of a
   * confusing double-resolution — and every device (including the one that
   * didn't answer) is told the prompt is gone via `choice_resolved`, so a
   * stale card doesn't linger on a screen the user isn't looking at anymore.
   *
   * `pendingApproval`'s answer resolves the blocked tool call directly —
   * the `claude` child spawned this turn is still alive waiting for it.
   * `pendingChoice`'s answer has no call left to resolve (the turn that
   * asked already ended, or ended immediately after asking) — `SharedSession`
   * enqueues it as an ordinary new turn instead, using the `answers` this
   * returns. */
  answerChoice(promptId: string, answers: ChoiceAnswer[]): AnswerChoiceResult {
    if (this.pendingApproval?.promptId === promptId) {
      const pending = this.pendingApproval;
      this.pendingApproval = undefined;
      broadcastChoiceResolved(this.clients, promptId);
      pending.resolve(answers);
      return { kind: "approval" };
    }
    if (this.pendingChoice?.promptId === promptId && this.active === "choice") {
      this.pendingChoice = undefined;
      this.active = undefined;
      broadcastChoiceResolved(this.clients, promptId);
      this.mirror(undefined);
      this.publishNext();
      return { kind: "choice", answers };
    }
    if (this.deferredApproval?.promptId === promptId && this.active === "approval") {
      const { calls, questions } = this.deferredApproval;
      this.deferredApproval = undefined;
      this.active = undefined;
      broadcastChoiceResolved(this.clients, promptId);
      this.mirrorApproval(undefined);
      this.publishNext();
      return { kind: "deferredApproval", calls, questions, answers };
    }
    return { kind: "not_found" };
  }

  /** Sends whichever of the two slots is currently open to a newly
   * connected (or reconnecting) socket — called from `SharedSession.addClient`.
   * `pendingApproval` sent LAST so, if the client just keeps whichever
   * `choice_prompt` arrived most recently as "the" current one (it does,
   * `useRelayClient.ts`), the time-critical one (the CLI is actually
   * blocked waiting on it) is the one a reconnecting device sees, not the
   * deferred one that's fine to answer whenever. Both can legitimately be
   * set at once — see the class doc comment above. */
  sendPendingTo(socket: WebSocket): void {
    if (this.active === "choice" && this.pendingChoice) sendChoicePrompt(socket, this.pendingChoice, "choice");
    if (this.active === "approval" && this.deferredApproval) sendChoicePrompt(socket, this.deferredApproval, "approval");
    if (this.pendingApproval) sendChoicePrompt(socket, this.pendingApproval, "approval");
  }
}
