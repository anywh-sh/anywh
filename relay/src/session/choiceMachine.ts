import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { type ChoiceAnswer, type ChoiceQuestion } from "../bridges/mcpBridge.js";
import type { PermissionDecision } from "../bridges/permissionBridge.js";
import { broadcastChoicePrompt, broadcastChoiceResolved, sendChoicePrompt } from "./broadcast.js";
import { buildApprovalQuestion, isApproved } from "./turnMessages.js";

/** What `answerChoice` resolved, told apart so `SharedSession` (the only
 * caller with a `turnQueue`/`runTurn` to act on it) knows what side effect
 * to run — this class doesn't know about turns, sessions, or Claude at all,
 * on purpose: it's the piece Fase 10 reuses for the Codex approval bridge
 * without going through `permissionBridge.ts`. */
export type AnswerChoiceResult =
  | { kind: "not_found" }
  | { kind: "approval" }
  | { kind: "choice"; answers: ChoiceAnswer[] };

/**
 * Owns the two pending-question slots a session can have open at once.
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
 * (`checkPermission`/`presentApprovalChoice`) and stays BLOCKING on
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
 * Both in-memory only, same reasoning as `SharedSession`'s other
 * turn-scoped state: on a relay restart there's nothing meaningful left to
 * resume for `pendingApproval` either way (its underlying `claude` child
 * dies too, see `McpChoiceBridge`'s per-turn `unregister`) — a fresh
 * session simply has no pending approval, which is correct. `pendingChoice`
 * is the one case where a restart now has real (if rare) user-visible cost
 * — an unanswered `present_choice`/plan-marker prompt just disappears, same
 * as it silently already did for the plan-marker case since Fase 3.
 * Accepted rather than persisted (no `sessionStore.ts` entry): the
 * conversation itself survives a restart fine via the persisted
 * `session_id`, the human only loses the one pending question and can just
 * ask the model to repeat it — not worth the complexity of persisting a
 * JSON blob for a window this narrow (a relay restart landing in the exact
 * gap between "prompt shown" and "human answers").
 */
export class ChoiceMachine {
  private pendingApproval: { promptId: string; questions: ChoiceQuestion[]; resolve: (answers: ChoiceAnswer[]) => void } | undefined;
  private pendingChoice: { promptId: string; questions: ChoiceQuestion[] } | undefined;

  constructor(private readonly clients: Set<WebSocket>) {}

  /** Called by the MCP bridge
   * (`McpChoiceBridge`, `ChoiceHost.presentChoice`) when the model calls
   * `present_choice`. Used to return a `Promise<ChoiceAnswer[]>` and hold the
   * tool call open until `answerChoice` resolved it — abandoned because the
   * CLI kills a `tools/call` after ~6 minutes with no working override
   * (Descoberta 8), and a human reading a prompt on their phone routinely
   * takes longer than that. Now synchronous: publishes the prompt and
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
    this.pendingChoice = { promptId, questions };
    broadcastChoicePrompt(this.clients, this.pendingChoice, "choice");
    return true;
  }

  /** Called by the permission-prompt-tool bridge
   * (`McpPermissionBridge`) for every tool call the CLI itself decided
   * needs human approval given the turn's current mode (see
   * `SharedSession.runTurn`'s `permissionRegistration` — wired for every
   * mode except `bypassPermissions`). Validated against the real binary
   * before writing this: the CLI, not the relay, already does the risk
   * classification — trivial reads/Bash (e.g. `echo`) never reach here at
   * all in `default`, and `acceptEdits` still routes a dangerous-looking
   * `Bash` (`rm -rf`) here despite auto-allowing harmless file edits. So
   * there's no risk policy left for us to invent: anything that reaches
   * this function already needs a real yes/no, we just have to ask it
   * instead of the blanket auto-allow this replaced.
   *
   * `ExitPlanMode` keeps its own wording (a mode transition reads
   * differently than "approve this action"), everything else gets a
   * generic question built from `describeToolCall` (turnMessages.ts).
   *
   * Reuses `presentApprovalChoice` (below) as-is instead of inventing a
   * parallel pending-approval mechanism: a single yes/no `ChoiceQuestion`
   * renders fine with the existing `ChoiceCard`, and
   * `presentApprovalChoice`/`answerChoice` already handle every lifecycle
   * edge case (multi-device "first answer wins", cancellation on any form of
   * turn end, Stop button) that a fresh mechanism would need to reimplement
   * — so reusing it needed no new turn-state UI: the mechanism was already
   * generic, only the policy it replaced was narrow. */
  async checkPermission(toolName: string, input: unknown, _toolUseId: string | undefined): Promise<PermissionDecision> {
    const answers = await this.presentApprovalChoice([buildApprovalQuestion(toolName, input)]);
    const approved = isApproved(answers);
    const isExitPlanMode = toolName === "ExitPlanMode";
    if (approved) return { behavior: "allow", updatedInput: input };
    return {
      behavior: "deny",
      message: isExitPlanMode ? "O usuário optou por continuar no modo Plan." : "O usuário recusou a execução.",
    };
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
   * behaves, still subject to the SAME ~6 minute CLI timeout as
   * `present_choice` used to be — that remains a known, open limitation for
   * THIS path, deliberately out of scope for the present rework, see
   * `SharedSession.runTurn`'s `mcpServers` comment). Every lifecycle path
   * that could leave this dangling — client disconnect, session delete,
   * relay shutdown — resolves through the SAME turn-in-progress machinery
   * `stopTurn`/`waitForIdle` use, via `cancelPendingApproval` in `runTurn`'s
   * `finally`. */
  private presentApprovalChoice(questions: ChoiceQuestion[]): Promise<ChoiceAnswer[]> {
    return new Promise((resolve) => {
      const promptId = randomUUID();
      this.pendingApproval = { promptId, questions, resolve };
      broadcastChoicePrompt(this.clients, this.pendingApproval, "approval");
    });
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
  discardStaleChoice(): void {
    if (!this.pendingChoice) return;
    const { promptId } = this.pendingChoice;
    this.pendingChoice = undefined;
    broadcastChoiceResolved(this.clients, promptId);
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
    if (this.pendingChoice?.promptId === promptId) {
      this.pendingChoice = undefined;
      broadcastChoiceResolved(this.clients, promptId);
      return { kind: "choice", answers };
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
    if (this.pendingChoice) sendChoicePrompt(socket, this.pendingChoice, "choice");
    if (this.pendingApproval) sendChoicePrompt(socket, this.pendingApproval, "approval");
  }
}
