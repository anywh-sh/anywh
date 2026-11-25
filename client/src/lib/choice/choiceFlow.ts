import type { ChoiceAnswer, ChoiceQuestion } from "@/lib/relay/relayClient";

/**
 * The answer to a prompt as the user builds it, one question at a time. One
 * `choice_answer` is sent for the WHOLE prompt at once (not per question, see
 * relay/src/session/sharedSession.ts::answerChoice), so this accumulates an answer
 * per question locally as the user steps through them, and only produces the
 * final answers once the last one is confirmed or skipped.
 *
 * Pure on purpose: the web card and the iOS native sheet both drive the same
 * transitions, so the two can't disagree on what an answer means.
 */
export interface ChoiceFlow {
  /** The question on screen. */
  index: number;
  /** Confirmed answers, per question index. */
  answers: ReadonlyMap<number, string[]>;
  /** What's checked on the question on screen. */
  selected: string[];
  /** Free text typed per question index, kept while stepping around. */
  customTexts: ReadonlyMap<number, string>;
  /** The free text of the question on screen. */
  customText: string;
}

/** Where every prompt starts — a fresh one always starts over. */
export const INITIAL_CHOICE_FLOW: ChoiceFlow = {
  index: 0,
  answers: new Map(),
  selected: [],
  customTexts: new Map(),
  customText: "",
};

/** Free text always wins over checked options when both are present — kept
 * mutually exclusive (see `toggleOption`/`setCustomText`) so there's never an
 * ambiguous "which one did they mean" at confirm time. */
export function effectiveSelection(flow: ChoiceFlow): string[] {
  return flow.customText.trim() ? [flow.customText.trim()] : flow.selected;
}

/** Moves to another question, bringing back what was confirmed or typed
 * there before. */
export function goTo(flow: ChoiceFlow, nextIndex: number): ChoiceFlow {
  return {
    ...flow,
    index: nextIndex,
    selected: flow.answers.get(nextIndex) ?? [],
    customText: flow.customTexts.get(nextIndex) ?? "",
  };
}

/** Checks or unchecks an option of the question on screen. Picking an option
 * drops any free text typed for this question; a single-select question
 * holds at most one. */
export function toggleOption(flow: ChoiceFlow, question: ChoiceQuestion, value: string): ChoiceFlow {
  const customTexts = new Map(flow.customTexts);
  customTexts.delete(flow.index);
  const selected = question.multiSelect
    ? flow.selected.includes(value)
      ? flow.selected.filter((item) => item !== value)
      : [...flow.selected, value]
    : flow.selected.includes(value)
      ? []
      : [value];
  return { ...flow, customText: "", customTexts, selected };
}

/** Types free text for the question on screen; any text at all unchecks the
 * options. */
export function setCustomText(flow: ChoiceFlow, value: string): ChoiceFlow {
  const customTexts = new Map(flow.customTexts).set(flow.index, value);
  const selected = value.trim() && flow.selected.length > 0 ? [] : flow.selected;
  return { ...flow, customText: value, customTexts, selected };
}

/** The wire answers for a prompt: one per question, an empty selection for
 * any question never reached, so the relay always gets a full set. */
export function answersFor(questions: ChoiceQuestion[], answers: ReadonlyMap<number, string[]>): ChoiceAnswer[] {
  return questions.map((question, questionIndex) => ({ question: question.question, selected: answers.get(questionIndex) ?? [] }));
}

export type ConfirmOutcome = { kind: "next"; flow: ChoiceFlow } | { kind: "done"; answers: ChoiceAnswer[] };

/** Confirms the question on screen with `withSelection` (`[]` is "skip"):
 * on to the next question, or, on the last one, the finished answers. */
export function confirmCurrent(flow: ChoiceFlow, questions: ChoiceQuestion[], withSelection: string[]): ConfirmOutcome {
  const answers = new Map(flow.answers).set(flow.index, withSelection);
  if (flow.index === questions.length - 1) return { kind: "done", answers: answersFor(questions, answers) };
  return { kind: "next", flow: goTo({ ...flow, answers }, flow.index + 1) };
}
