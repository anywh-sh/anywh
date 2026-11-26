import { useEffect, useMemo, useRef, useState } from "react";
import { useDict } from "@/i18n";
import { useShellTheme } from "@/hooks/platform/useNativeShell";
import type { PendingChoice } from "@/hooks/relay/useRelayClient";
import { INITIAL_CHOICE_FLOW, confirmCurrent, effectiveSelection, goTo, setCustomText, toggleOption, type ChoiceFlow } from "@/lib/choice/choiceFlow";
import { optionValue } from "@/lib/choice/choiceText";
import { listenNativeChoice, setNativeChoice } from "@/lib/platform/nativeChoice";
import { buildChoicePayload, choiceStepKey } from "@/lib/platform/nativeChoiceModel";
import type { ChoiceAnswer } from "@/lib/relay/relayClient";

interface NativeChoiceSheetProps {
  /** The pending prompt, or `null` when nothing is pending. */
  prompt: PendingChoice | null;
  /** The answer can't reach the relay right now (reconnecting). */
  disabled: boolean;
  onAnswer: (answers: ChoiceAnswer[]) => void;
}

/** The answer being built, tagged with the prompt it belongs to: a different
 * prompt always starts over, even before any effect could reset it. */
interface FlowState {
  promptId: string | null;
  flow: ChoiceFlow;
  /** What the free-text field opens with on the question on screen. Only
   * moves when the question does: while the user types, the field's text is
   * the native side's, so the payload doesn't change (and isn't resent) on
   * every keystroke. */
  fieldText: string;
}

const INITIAL_STATE: FlowState = { promptId: null, flow: INITIAL_CHOICE_FLOW, fieldText: "" };

function stateOf(state: FlowState, promptId: string): FlowState {
  return state.promptId === promptId ? state : { ...INITIAL_STATE, promptId };
}

/** The flow after `next`, with the field's opening text following a change
 * of question. */
function advance(state: FlowState, next: ChoiceFlow): FlowState {
  return { ...state, flow: next, fieldText: next.index === state.flow.index ? state.fieldText : next.customText };
}

/**
 * iOS: the pending prompt as a row inside the native composer that opens a
 * native sheet (the `native-chrome` plugin's `setChoice`), in place of the web
 * `ChoiceCard`, which took the whole screen above the keyboard. Headless, like
 * `NativeComposer`: this side holds the answer being built — the same
 * `choiceFlow` transitions as `ChoiceCard` — and sends the question on screen;
 * native draws it and reports taps and typing back. Unmounting takes the row
 * and the sheet away.
 *
 * Every native event names the question it was made on (`stepKey`), and one
 * made on a question no longer on screen is dropped: a second tap on Next
 * lands after the first moved on, and would otherwise skip the next question
 * with nothing chosen. A prompt is answered once: the answer clears it, but
 * only on the next render, and a second Send can arrive before that.
 */
export function NativeChoiceSheet({ prompt, disabled, onAnswer }: NativeChoiceSheetProps) {
  const dict = useDict();
  const theme = useShellTheme();

  const [state, setState] = useState<FlowState>(INITIAL_STATE);
  // Native events can arrive back to back (the last keystroke, then Return):
  // each one has to see what the previous one did, not the last render.
  const stateRef = useRef(state);
  const answeredRef = useRef<string | null>(null);

  // Latest props for the native callbacks, which outlive any one render.
  const propsRef = useRef({ prompt, disabled, onAnswer });
  propsRef.current = { prompt, disabled, onAnswer };

  const payload = useMemo(() => {
    if (!prompt) return null;
    const current = stateOf(state, prompt.promptId);
    return buildChoicePayload({
      dict,
      theme,
      promptId: prompt.promptId,
      kind: prompt.kind,
      questions: prompt.questions,
      flow: current.flow,
      fieldText: current.fieldText,
      disabled,
    });
  }, [dict, theme, prompt, state, disabled]);

  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    const serialized = JSON.stringify(payload);
    if (serialized === lastSentRef.current) return;
    lastSentRef.current = serialized;
    void setNativeChoice(payload).catch(() => {});
  }, [payload]);

  // The row and the sheet belong to this panel: leaving takes them away.
  useEffect(
    () => () => {
      lastSentRef.current = null;
      void setNativeChoice(null).catch(() => {});
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const commit = (next: FlowState): void => {
      stateRef.current = next;
      setState(next);
    };

    /** The prompt pending right now and its answer so far, if `stepKey` is
     * the question on screen; `null` for an event made on another one. */
    const onScreen = (stepKey: string): { current: PendingChoice; state: FlowState } | null => {
      const current = propsRef.current.prompt;
      if (!current || answeredRef.current === current.promptId) return null;
      const state = stateOf(stateRef.current, current.promptId);
      return choiceStepKey(current.promptId, state.flow.index) === stepKey ? { current, state } : null;
    };

    /** Applies a change to the answer of the question on screen. */
    const update = (stepKey: string, change: (flow: ChoiceFlow, current: PendingChoice) => ChoiceFlow): void => {
      const target = onScreen(stepKey);
      if (target) commit(advance(target.state, change(target.state.flow, target.current)));
    };

    /** Confirms the question on screen: on to the next one, or the answer. */
    const confirm = (stepKey: string, selectionOf: (flow: ChoiceFlow) => string[]): void => {
      const target = onScreen(stepKey);
      if (!target || propsRef.current.disabled) return;
      const { current, state } = target;
      const outcome = confirmCurrent(state.flow, current.questions, selectionOf(state.flow));
      if (outcome.kind === "next") {
        commit(advance(state, outcome.flow));
        return;
      }
      answeredRef.current = current.promptId;
      propsRef.current.onAnswer(outcome.answers);
    };

    void listenNativeChoice({
      choiceToggleOption: ({ stepKey, index }) =>
        update(stepKey, (flow, current) => {
          const question = current.questions[flow.index];
          const option = question?.options[index];
          return option ? toggleOption(flow, question, optionValue(option)) : flow;
        }),
      choiceCustomTextChange: ({ stepKey, text }) => update(stepKey, (flow) => setCustomText(flow, text)),
      choicePrevious: ({ stepKey }) => update(stepKey, (flow) => (flow.index > 0 ? goTo(flow, flow.index - 1) : flow)),
      choiceSubmit: ({ stepKey }) => confirm(stepKey, effectiveSelection),
      choiceSkip: ({ stepKey }) => confirm(stepKey, () => []),
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return null;
}
