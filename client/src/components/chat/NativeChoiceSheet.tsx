import { useEffect, useMemo, useRef, useState } from "react";
import { useDict } from "@/i18n";
import { toHex, useThemeVersion } from "@/hooks/platform/useNativeShell";
import type { PendingChoice } from "@/hooks/relay/useRelayClient";
import { INITIAL_CHOICE_FLOW, confirmCurrent, effectiveSelection, goTo, setCustomText, toggleOption, type ChoiceFlow } from "@/lib/choice/choiceFlow";
import { optionValue } from "@/lib/choice/choiceText";
import { listenNativeChoice, setNativeChoice } from "@/lib/platform/nativeChoice";
import { buildChoicePayload } from "@/lib/platform/nativeChoiceModel";
import { buildShellTheme } from "@/lib/platform/nativeShellModel";
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
}

function flowOf(state: FlowState, promptId: string): ChoiceFlow {
  return state.promptId === promptId ? state.flow : INITIAL_CHOICE_FLOW;
}

/**
 * iOS: the pending prompt as a row inside the native composer that opens a
 * native sheet (the `native-chrome` plugin's `setChoice`), in place of the web
 * `ChoiceCard`, which took the whole screen above the keyboard. Headless, like
 * `NativeComposer`: this side holds the answer being built — the same
 * `choiceFlow` transitions as `ChoiceCard` — and sends the question on screen;
 * native draws it and reports taps and typing back. Unmounting takes the row
 * and the sheet away.
 */
export function NativeChoiceSheet({ prompt, disabled, onAnswer }: NativeChoiceSheetProps) {
  const dict = useDict();
  const themeVersion = useThemeVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const theme = useMemo(() => buildShellTheme(toHex), [themeVersion]);

  const [state, setState] = useState<FlowState>({ promptId: null, flow: INITIAL_CHOICE_FLOW });
  // Native events can arrive back to back (the last keystroke, then Return):
  // each one has to see what the previous one did, not the last render.
  const stateRef = useRef(state);
  const commit = (next: FlowState): void => {
    stateRef.current = next;
    setState(next);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // Latest props for the native callbacks, which outlive any one render.
  const propsRef = useRef({ prompt, disabled, onAnswer });
  propsRef.current = { prompt, disabled, onAnswer };

  const payload = useMemo(
    () =>
      prompt
        ? buildChoicePayload({
            dict,
            theme,
            promptId: prompt.promptId,
            kind: prompt.kind,
            questions: prompt.questions,
            flow: flowOf(state, prompt.promptId),
            disabled,
          })
        : null,
    [dict, theme, prompt, state, disabled],
  );

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

    /** Applies a change to the answer of the prompt pending right now. */
    const update = (change: (flow: ChoiceFlow, current: PendingChoice) => ChoiceFlow): void => {
      const current = propsRef.current.prompt;
      if (!current) return;
      const flow = flowOf(stateRef.current, current.promptId);
      commitRef.current({ promptId: current.promptId, flow: change(flow, current) });
    };

    /** Confirms the question on screen: the next one, or the answer. */
    const confirm = (selectionOf: (flow: ChoiceFlow) => string[]): void => {
      const { prompt: current, disabled: held, onAnswer: answer } = propsRef.current;
      if (!current || held) return;
      const flow = flowOf(stateRef.current, current.promptId);
      const outcome = confirmCurrent(flow, current.questions, selectionOf(flow));
      if (outcome.kind === "done") answer(outcome.answers);
      else commitRef.current({ promptId: current.promptId, flow: outcome.flow });
    };

    void listenNativeChoice({
      choiceToggleOption: ({ index }) =>
        update((flow, current) => {
          const question = current.questions[flow.index];
          const option = question?.options[index];
          return option ? toggleOption(flow, question, optionValue(option)) : flow;
        }),
      choiceCustomTextChange: ({ text }) => update((flow) => setCustomText(flow, text)),
      choicePrevious: () => update((flow) => (flow.index > 0 ? goTo(flow, flow.index - 1) : flow)),
      choiceSubmit: () => confirm(effectiveSelection),
      choiceSkip: () => confirm(() => []),
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
