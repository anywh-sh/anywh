// Pure builders/interpreters for a native `TurnHost.requestApproval`/
// `requestUserInput` call — extracted out of `SharedSession` so the
// question-building and answer-interpretation logic is table-testable
// without constructing a full session, same reasoning `runtimes/README.md`
// §2/§8 gives for a def's own functions, applied one layer up. Mirrors
// `runtimes/defs/claude/mcpSpawnConfig.ts`'s `buildApprovalQuestion`/
// `isApproved` pair, which does the same split for the bridged (Claude)
// approval path.
import type { ChoiceAnswer, ChoiceQuestion } from "../bridges/mcpBridge.js";
import type { ApprovalRequest, UserInputAnswer, UserInputQuestion } from "../runtimes/types.js";
import { resolveDecisionLabel } from "./approvalLabels.js";

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
