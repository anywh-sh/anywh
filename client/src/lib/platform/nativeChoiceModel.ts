import type { Dictionary } from "@/i18n/dictionary";
import type { ChoiceFlow } from "@/lib/choice/choiceFlow";
import { allowsCustomText, optionLabel, optionValue, questionText } from "@/lib/choice/choiceText";
import type { NativeChoicePayload } from "@/lib/platform/nativeChoice";
import type { NativeShellTheme } from "@/lib/platform/nativeShell";
import type { ChoiceQuestion } from "@/lib/relay/relayClient";

export interface ChoiceModelInput {
  dict: Dictionary;
  theme: NativeShellTheme;
  promptId: string;
  /** `"approval"` is a live blocked tool call, `"choice"` a deferred prompt. */
  kind: "approval" | "choice";
  questions: ChoiceQuestion[];
  /** The answer being built (`choiceFlow`). */
  flow: ChoiceFlow;
  /** What the free-text field opens with on this question. The native side
   * applies it only when the question changes (the field is its own while
   * the user types), so it is passed apart from the live `flow.customText`
   * and the payload stays the same while typing. */
  fieldText: string;
  /** The answer can't reach the relay right now (reconnecting). */
  disabled: boolean;
}

/** Names one question of one prompt. The payload carries it, and every event
 * the native sheet reports carries back the one it was made on. */
export function choiceStepKey(promptId: string, index: number): string {
  return `${promptId}:${String(index)}`;
}

/**
 * Everything the composer's pending-question row and the native question
 * sheet draw for the question on screen, worded and translated here so the
 * native side holds no logic and no copy. Same rules as the web
 * `ChoiceCard`: the option copy, the composed approval sentence and the
 * free-text rule all come from `choiceText`.
 */
export function buildChoicePayload(input: ChoiceModelInput): NativeChoicePayload {
  const { dict, flow, questions, kind } = input;
  const copy = dict.chat.choice;
  const question = questions[flow.index];
  const text = questionText(question, dict);
  const position =
    questions.length > 1 ? copy.questionPosition.replace("{index}", String(flow.index + 1)).replace("{total}", String(questions.length)) : null;
  const isLast = flow.index === questions.length - 1;

  return {
    stepKey: choiceStepKey(input.promptId, flow.index),
    banner: { label: kind === "approval" ? copy.pendingApproval : copy.pending, text, openLabel: copy.open },
    kicker: question.header ? question.header : kind === "approval" ? copy.kickerApproval : copy.kickerQuestion,
    position,
    question: text,
    multiSelect: question.multiSelect === true,
    options: question.options.map((option) => ({
      label: optionLabel(option, dict),
      description: option.description ? option.description : null,
      selected: flow.selected.includes(optionValue(option)),
    })),
    optionsDimmed: flow.customText.trim().length > 0,
    custom: allowsCustomText(kind, question)
      ? { text: input.fieldText, placeholder: copy.customPlaceholder, label: copy.customLabel, secret: question.secret === true }
      : null,
    canGoBack: flow.index > 0,
    canAnswer: !input.disabled,
    status: input.disabled ? dict.chat.connection.sendBlocked : null,
    submitLabel: isLast ? dict.common.send : copy.next,
    skipLabel: copy.skip,
    strings: { close: dict.common.close, previous: copy.previousQuestion },
    theme: input.theme,
  };
}
