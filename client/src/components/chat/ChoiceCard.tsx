import { useEffect, useRef, useState } from "react";
import { TextButton } from "@/components/ui/text-button";
import { RowButton } from "@/components/ui/row-button";
import { ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isIOS } from "@/lib/platform/platform";
import { useDict } from "@/i18n";
import * as choiceFlow from "@/lib/choice/choiceFlow";
import { allowsCustomText, optionLabel, optionValue, questionText } from "@/lib/choice/choiceText";
import type { ChoiceAnswer, ChoiceQuestion } from "@/lib/relay/relayClient";

interface ChoiceCardProps {
  promptId: string;
  questions: ChoiceQuestion[];
  /** `"approval"` (a live blocked tool call, e.g. permission approve/deny)
   * genuinely needs SOME answer to unblock it — the top-right button falls
   * back to `onAnswer` with whatever's selected, same as before. `"choice"`
   * (the `present_choice` MCP tool / plan-mode marker) has no live call
   * waiting, so that button only collapses the card to a small indicator
   * above the composer instead — see the `collapsed` state below and the
   * `choice_prompt` doc comment in relay-types.ts. */
  kind: "approval" | "choice";
  onAnswer: (answers: ChoiceAnswer[]) => void;
  /** The answer can't reach the relay right now (reconnecting): the card
   * stays readable, the controls that would answer it wait. */
  disabled?: boolean;
}

/** Picker for a `present_choice` MCP call blocked
 * mid-turn, styled after Claude Desktop's own `AskUserQuestion` card.
 * Sits right above the
 * composer, replacing the old row of dir/files/terminal buttons there (moved
 * below the composer instead — see ChatPanel.tsx).
 *
 * The answer is built one question at a time by the pure `choiceFlow`
 * transitions (shared with the iOS native sheet), and `onAnswer` is called
 * once the last question is confirmed or skipped, or (for `kind: "approval"`
 * only) the user closes the card early, filling in whatever wasn't reached
 * yet with an empty selection so the live blocked tool call always genuinely
 * unblocks. `kind: "choice"` collapses instead of answering — see
 * `ChoiceCardProps.kind` and the `collapsed` state. */
export function ChoiceCard({ promptId, questions, kind, onAnswer, disabled = false }: ChoiceCardProps) {
  const dict = useDict();
  const [flow, setFlow] = useState<choiceFlow.ChoiceFlow>(choiceFlow.INITIAL_CHOICE_FLOW);
  // Only ever set for `kind: "choice"` (the top-right button answers
  // directly for `kind: "approval"` instead, see its `onClick` below) — the
  // card stays mounted while collapsed, so every other piece of state above
  // (current step, partial answers, in-progress custom text) survives a
  // collapse/reopen round trip untouched.
  const [collapsed, setCollapsed] = useState(false);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // A fresh prompt (new `promptId`) always starts over — same instance can
  // be reused across prompts since `ChatPanel` keys it by `choicePrompt`
  // state, not by mount/unmount.
  useEffect(() => {
    setFlow(choiceFlow.INITIAL_CHOICE_FLOW);
    setCollapsed(false);
  }, [promptId]);

  const { index, answers, selected, customText } = flow;
  const question = questions[index];
  const isLast = index === questions.length - 1;
  const effectiveSelection = choiceFlow.effectiveSelection(flow);

  // The card's own actions: the pure transitions of `choiceFlow` applied to
  // this card's state, with the `disabled` guard on what would answer.
  function goTo(nextIndex: number): void {
    setFlow((current) => choiceFlow.goTo(current, nextIndex));
  }

  function toggleOption(label: string): void {
    setFlow((current) => choiceFlow.toggleOption(current, questions[current.index], label));
  }

  function setCustomTextFor(value: string): void {
    setFlow((current) => choiceFlow.setCustomText(current, value));
  }

  function finish(finalAnswers: Map<number, string[]>): void {
    if (disabled) return;
    onAnswer(choiceFlow.answersFor(questions, finalAnswers));
  }

  function confirmCurrent(withSelection: string[]): void {
    if (disabled) return;
    const outcome = choiceFlow.confirmCurrent(flow, questions, withSelection);
    if (outcome.kind === "done") {
      onAnswer(outcome.answers);
      return;
    }
    setFlow(outcome.flow);
  }

  /** Up/down moves focus between option buttons (a roving-focus listbox,
   * clamped rather than wrapping — same edge behavior as the question
   * chevrons above). Selecting still happens on Enter/Space, which a
   * focused button already handles natively — this only owns where the
   * arrow keys send focus next. */
  function handleOptionKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, optionIndex: number): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const nextIndex = optionIndex + (event.key === "ArrowDown" ? 1 : -1);
    optionRefs.current[nextIndex]?.focus();
  }

  if (collapsed) {
    return (
      // Narrower than the card it replaces and centered — a tab welded onto
      // the composer below rather than a second floating box the same size
      // as either. No bottom border, and a negative margin overlapping the
      // composer's own top border by 1px (`z-10` keeps this tab painted over
      // that border despite Composer following it in the DOM) — desktop's
      // Composer has no top spacing of its own (`mb-3` only, Composer.tsx),
      // so this 1px is the whole overlap. On iOS the composer is native and
      // sits below the stack with its own strip between them, so the tab just
      // sits at the end of the stack with the stack's normal `gap-2`.
      <div className={cn("relative z-10 flex justify-center", isIOS() ? "shrink-0" : "mx-3 mt-3 -mb-[1px]")}>
        <RowButton
          size="auto"
          onClick={() => setCollapsed(false)}
          aria-label={dict.chat.choice.reopen}
          className="w-[72%] gap-2 border-x border-t border-primary bg-bg-elevated px-3 py-2 text-sm text-foreground hover:bg-surface-hover"
        >
          <span className="size-1.5 shrink-0 animate-pulse bg-primary" />
          <span className="font-medium">{dict.chat.choice.pending}</span>
          {questions.length > 1 && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {dict.chat.choice.questionPosition.replace("{index}", String(index + 1)).replace("{total}", String(questions.length))}
            </span>
          )}
          <span className="flex-1" />
          <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
        </RowButton>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 border border-border bg-bg-elevated p-3",
        // On iOS the parent stack already provides horizontal padding + gap
        // between siblings — an extra margin here would misalign
        // this card against the composer/edit-warning next to it.
        isIOS() ? "shrink-0" : "mx-3 mt-3",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          {question.header && <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{question.header}</p>}
          <p className="text-sm font-medium text-foreground">{questionText(question, dict)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {questions.length > 1 && (
            <>
              <TextButton onClick={() => goTo(index - 1)} disabled={index === 0} aria-label={dict.chat.choice.previousQuestion} className="disabled:opacity-30">
                <ChevronLeft className="size-4" />
              </TextButton>
              <span className="px-1 font-mono text-[11px] text-muted-foreground">
                {dict.chat.choice.questionPosition.replace("{index}", String(index + 1)).replace("{total}", String(questions.length))}
              </span>
              <TextButton onClick={() => goTo(index + 1)} disabled={isLast} aria-label={dict.chat.choice.nextQuestion} className="disabled:opacity-30">
                <ChevronRight className="size-4" />
              </TextButton>
            </>
          )}
          <TextButton
            onClick={() => (kind === "approval" ? finish(new Map(answers).set(index, effectiveSelection)) : setCollapsed(true))}
            disabled={disabled && kind === "approval"}
            aria-label={kind === "approval" ? dict.chat.choice.closeAnswering : dict.chat.choice.collapse}
            className="ml-1"
          >
            {kind === "approval" ? <X className="size-4" /> : <ChevronDown className="size-4" />}
          </TextButton>
        </div>
      </div>

      <div className={cn("flex flex-col divide-y divide-border", customText.trim() && "opacity-40")}>
        {question.options.map((option, optionIndex) => {
          const value = optionValue(option);
          const isSelected = selected.includes(value);
          return (
            <TextButton
              tone="none"
              key={value}
              ref={(el) => {
                optionRefs.current[optionIndex] = el;
              }}
              onClick={() => toggleOption(value)}
              onKeyDown={(event) => handleOptionKeyDown(event, optionIndex)}
              className="flex items-center gap-2.5 py-2"
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center border",
                  isSelected ? "border-primary bg-primary text-primary-foreground" : "border-border",
                )}
              >
                <Check className={cn("size-3", !isSelected && "opacity-0")} />
              </span>
              <span className="flex flex-col">
                <span className="text-sm text-foreground">{optionLabel(option, dict)}</span>
                {option.description && <span className="text-xs text-muted-foreground">{option.description}</span>}
              </span>
            </TextButton>
          );
        })}
      </div>

      {/* Free-text fallback — always the last option (see `allowsCustomText`). */}
      {allowsCustomText(kind, question) && (
        <input
          type={question.secret ? "password" : "text"}
          value={customText}
          onChange={(event) => setCustomTextFor(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && customText.trim()) confirmCurrent([customText.trim()]);
          }}
          placeholder={dict.chat.choice.customPlaceholder}
          aria-label={dict.chat.choice.customLabel}
          className="min-w-0 border border-border bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
        />
      )}

      <div className="flex items-center justify-between pt-1">
        <span className="font-mono text-[11px] text-text-faint">
          {customText.trim()
            ? dict.chat.choice.customAnswer
            : disabled
              ? dict.chat.connection.sendBlocked
              : dict.chat.choice.selectedCount.replace("{count}", String(selected.length))}
        </span>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={() => confirmCurrent([])}>
            {dict.chat.choice.skip}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            disabled={disabled}
            onClick={() => confirmCurrent(effectiveSelection)}
            aria-label={isLast ? dict.chat.choice.submit : dict.chat.choice.nextQuestion}
          >
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
