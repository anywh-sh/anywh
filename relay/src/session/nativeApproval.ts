// Pure builders/interpreters for a native `TurnHost.requestApproval`/
// `requestUserInput` call — extracted out of `SharedSession` so the
// question-building and answer-interpretation logic is table-testable
// without constructing a full session, same reasoning `runtimes/README.md`
// §2/§8 gives for a def's own functions, applied one layer up. Mirrors
// `runtimes/defs/claude/mcpSpawnConfig.ts`'s `buildApprovalQuestion`/
// `isApproved` pair, which does the same split for the bridged (Claude)
// approval path.
import { createHash } from "node:crypto";
import type { ChoiceAnswer, ChoiceQuestion } from "../bridges/mcpBridge.js";
import type { ApprovalRequest, UserInputAnswer, UserInputQuestion } from "../runtimes/types.js";
import { compactToolInput } from "./approvalInput.js";
import { resolveDecisionLabel } from "./approvalLabels.js";
import type { DeferredToolCall } from "./sessionStore.js";
import type { DeferredApprovalDecision } from "./turnMessages.js";

export function buildApprovalQuestion(request: ApprovalRequest): ChoiceQuestion {
  return {
    question: request.summary,
    options: request.availableDecisions.map((decision) => ({ id: decision.id, label: resolveDecisionLabel(decision.labelKey) })),
    approval: request.detail && { tool: request.detail.kind, detail: request.detail.text, reason: request.detail.reason },
  };
}

/** The def declares its own fallback (`safeDecisionId`) rather than this
 * function guessing one — `session/` has no business knowing which of
 * another engine's decision ids means "no" (`runtimes/README.md` §0). */
export function resolveApprovalAnswer(answers: readonly ChoiceAnswer[], safeDecisionId: string | undefined): string {
  return answers[0]?.selected[0] ?? safeDecisionId ?? "";
}

export function buildUserInputQuestions(questions: readonly UserInputQuestion[]): ChoiceQuestion[] {
  return questions.map((question) => ({
    question: question.question,
    header: question.header,
    options: (question.options ?? []).map((option) => ({ label: option.label, description: option.description })),
    secret: question.secret || undefined,
  }));
}

/** Correlates each answer to its question by array position, not by
 * matching question text — mirrors the same convention `ChoiceCard.tsx`'s
 * `finish()` already uses to build its answer array, and what
 * `checkPermission`'s existing single-question usage already relies on
 * implicitly (`answers[0]`). */
export function resolveUserInputAnswers(questions: readonly UserInputQuestion[], answers: readonly ChoiceAnswer[]): UserInputAnswer[] {
  return questions.map((question, index) => ({ questionId: question.id, values: answers[index]?.selected ?? [] }));
}

// ---------------------------------------------------------------------------
// Deferred native approvals (`ApprovalRequest.deferrable`): the request was
// refused on the spot, kept as a card, and the person's verdict runs as a new
// turn in which the agent's repeat of each approved call is let through.

/** JSON with every object's keys sorted, so the same input always reads the
 * same however the agent ordered it. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, each]) => each !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${canonicalJson(each)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What a call is recognised by when the agent asks for it again: a digest of
 * the tool and its whole input. The stored copy of the input is shortened
 * (`compactToolInput`), so two calls that only differ past the cut would
 * otherwise read as one. */
export function nativeCallDigest(call: { readonly tool: string; readonly input: unknown }): string {
  return createHash("sha256").update(canonicalJson([call.tool, call.input])).digest("hex");
}

/** The decisions that let the call run: all but the safe one and any other
 * refusal the agent offers. */
export function approvingDecisionIds(request: ApprovalRequest): string[] {
  return request.availableDecisions
    .map((decision) => decision.id)
    .filter((id) => id !== request.safeDecisionId && !/reject|decline|deny|cancel/i.test(id));
}

/** The call a refused native request is kept as. */
export function deferredNativeCall(request: ApprovalRequest): DeferredToolCall {
  const call = request.deferrable?.call;
  return {
    tool: call?.tool ?? request.detail?.kind ?? "tool",
    input: compactToolInput(call?.input ?? (request.detail ? { detail: request.detail.text } : {})),
    toolUseId: request.id,
    native: { approveIds: approvingDecisionIds(request), ...(call ? { digest: nativeCallDigest(call) } : {}) },
  };
}

/** A call the person approved, for the turn that carries their verdict: the
 * agent's repeat of it (same digest) is answered with the decision they
 * picked — "for this session" stays "for this session". */
export interface NativeGrant {
  readonly digest: string;
  readonly decisionId: string;
}

/** The verdict on each call of an answered deferred card: what the follow-up
 * text tells the model, and which repeats the session lets through. An
 * approved call whose input was not known is told to the model as approved
 * but not cleared: the agent will ask about it again. */
export function planNativeVerdicts(
  calls: readonly DeferredToolCall[],
  questions: readonly ChoiceQuestion[],
  answers: readonly ChoiceAnswer[],
): { decisions: DeferredApprovalDecision[]; grants: NativeGrant[] } {
  const grants: NativeGrant[] = [];
  const decisions = calls.map((call, index): DeferredApprovalDecision => {
    const picked = answers[index]?.selected[0];
    const approved = picked !== undefined && (call.native?.approveIds.includes(picked) ?? false);
    const digest = call.native?.digest;
    if (approved && digest !== undefined) grants.push({ digest, decisionId: picked });
    return {
      tool: call.tool,
      detail: questions[index]?.approval?.detail ?? "",
      approved,
      granted: approved && digest !== undefined,
      ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
    };
  });
  return { decisions, grants };
}
