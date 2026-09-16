import { useEffect, useState } from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isIOS } from "@/lib/platform";
import { useDict } from "@/i18n";
import type { ChoiceAnswer, ChoiceOption, ChoiceQuestion } from "@/lib/relayClient";

interface ChoiceCardProps {
  promptId: string;
  questions: ChoiceQuestion[];
  /** `"approval"` (a live blocked tool call, e.g. permission approve/deny)
   * genuinely needs SOME answer to unblock it — the close button falls back
   * to `onAnswer` with whatever's selected, same as before. `"choice"` (the
   * `present_choice` MCP tool / plan-mode marker) has no live call waiting,
   * so the close button just calls `onClose` and sends nothing — see the
   * `choice_prompt` doc comment in relay-types.ts. */
  kind: "approval" | "choice";
  onAnswer: (answers: ChoiceAnswer[]) => void;
  onClose: () => void;
}

/** Picker for a `present_choice` MCP call blocked
 * mid-turn, styled after Claude Desktop's own `AskUserQuestion` card.
 * Sits right above the
 * composer, replacing the old row of dir/files/terminal buttons there (moved
 * below the composer instead — see ChatPanel.tsx).
 *
 * One `choice_answer` is sent for the WHOLE prompt at once (not per
 * question, see relay/src/sharedSession.ts::answerChoice) — this component
 * accumulates an answer per question locally as the user steps through them
 * and only calls `onAnswer` once the last one is confirmed or skipped, or
 * (for `kind: "approval"` only) the user closes the card early, filling in
 * whatever wasn't reached yet with an empty selection so the live blocked
 * tool call always genuinely unblocks. `kind: "choice"` closes with no
 * `onAnswer` call at all instead — see `ChoiceCardProps.kind`. */
export function ChoiceCard({ promptId, questions, kind, onAnswer, onClose }: ChoiceCardProps) {
  const dict = useDict();
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Map<number, string[]>>(new Map());
  const [selected, setSelected] = useState<string[]>([]);
  const [customTexts, setCustomTexts] = useState<Map<number, string>>(new Map());
  const [customText, setCustomText] = useState("");

  // A fresh prompt (new `promptId`) always starts over — same instance can
  // be reused across prompts since `ChatPanel` keys it by `choicePrompt`
  // state, not by mount/unmount.
  useEffect(() => {
    setIndex(0);
    setAnswers(new Map());
    setSelected([]);
    setCustomTexts(new Map());
    setCustomText("");
  }, [promptId]);

  const question = questions[index];
  const isLast = index === questions.length - 1;
  // Free text always wins over checked options when both are present — kept
  // mutually exclusive (see `toggleOption`/`setCustomTextFor`) so there's
  // never an ambiguous "which one did they mean" at confirm time.
  const effectiveSelection = customText.trim() ? [customText.trim()] : selected;

  function goTo(nextIndex: number): void {
    setIndex(nextIndex);
    setSelected(answers.get(nextIndex) ?? []);
    setCustomText(customTexts.get(nextIndex) ?? "");
  }

  /** What an answer carries for this option. The relay's own options (a
   * permission prompt) answer with a stable id, because the label the user
   * reads is written here and translated; the model's options answer with
   * the label itself, which is what gets fed back to the model. */
  function valueOf(option: ChoiceOption): string {
    return option.id ?? option.label;
  }

  /** The label to print. An option the relay wrote carries an id this app
   * already has copy for; an option the model wrote carries only its label,
   * which is the model's own words and belongs on screen as written. */
  function labelOf(option: ChoiceOption): string {
    if (option.id === "approve") return dict.chat.approval.approve;
    if (option.id === "deny") return dict.chat.approval.deny;
    return option.label;
  }

  /** A permission prompt is composed here rather than sent as a sentence, so
   * it follows the selected language. `question` stays the fallback for a
   * relay too old to send the parts. */
  function questionText(current: ChoiceQuestion): string {
    if (!current.approval) return current.question;
    if (current.approval.tool === "ExitPlanMode") return dict.chat.approval.exitPlanMode;
    return dict.chat.approval.toolCall
      .replace("{tool}", current.approval.tool)
      .replace("{detail}", current.approval.detail);
  }

  function toggleOption(label: string): void {
    setCustomText("");
    setCustomTexts((current) => {
      const next = new Map(current);
      next.delete(index);
      return next;
    });
    if (question.multiSelect) {
      setSelected((current) => (current.includes(label) ? current.filter((item) => item !== label) : [...current, label]));
    } else {
      setSelected((current) => (current.includes(label) ? [] : [label]));
    }
  }

  function setCustomTextFor(value: string): void {
    setCustomText(value);
    setCustomTexts((current) => new Map(current).set(index, value));
    if (value.trim() && selected.length > 0) setSelected([]);
  }

  function finish(finalAnswers: Map<number, string[]>): void {
    onAnswer(questions.map((question, questionIndex) => ({ question: question.question, selected: finalAnswers.get(questionIndex) ?? [] })));
  }

  function confirmCurrent(withSelection: string[]): void {
    const next = new Map(answers).set(index, withSelection);
    if (isLast) {
      finish(next);
      return;
    }
    setAnswers(next);
    goTo(index + 1);
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
          <p className="text-sm font-medium text-foreground">{questionText(question)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {questions.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => goTo(index - 1)}
                disabled={index === 0}
                aria-label={dict.chat.choice.previousQuestion}
                className="cursor-pointer text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="px-1 font-mono text-[11px] text-muted-foreground">
                {dict.chat.choice.questionPosition.replace("{index}", String(index + 1)).replace("{total}", String(questions.length))}
              </span>
              <button
                type="button"
                onClick={() => goTo(index + 1)}
                disabled={isLast}
                aria-label={dict.chat.choice.nextQuestion}
                className="cursor-pointer text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ChevronRight className="size-4" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => (kind === "approval" ? finish(new Map(answers).set(index, effectiveSelection)) : onClose())}
            aria-label={kind === "approval" ? dict.chat.choice.closeAnswering : dict.chat.choice.closeWithoutAnswering}
            className="ml-1 cursor-pointer text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div className={cn("flex flex-col divide-y divide-border", customText.trim() && "opacity-40")}>
        {question.options.map((option) => {
          const value = valueOf(option);
          const isSelected = selected.includes(value);
          return (
            <button
              type="button"
              key={value}
              onClick={() => toggleOption(value)}
              className="flex cursor-pointer items-center gap-2.5 py-2 text-left"
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
                <span className="text-sm text-foreground">{labelOf(option)}</span>
                {option.description && <span className="text-xs text-muted-foreground">{option.description}</span>}
              </span>
            </button>
          );
        })}
      </div>

      {/* Free-text fallback — always the last option, only for `present_choice`/
          plan-marker prompts. Not offered for `kind: "approval"`: that path
          resolves a tool call the CLI is blocked on, and it matches the answer
          against the two option ids it sent — free text matches neither, so
          offering it here would only ever stall the blocked call. */}
      {kind === "choice" && (
        <input
          type="text"
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
            : dict.chat.choice.selectedCount.replace("{count}", String(selected.length))}
        </span>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="secondary" size="sm" onClick={() => confirmCurrent([])}>
            {dict.chat.choice.skip}
          </Button>
          <Button
            type="button"
            size="icon-sm"
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
