import { memo } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/components/chat/Shimmer";
import { TargetChips } from "@/components/chat/activity/TargetChips";
import { ToolCallRow } from "@/components/chat/activity/ToolCallRow";
import { ToolIcon } from "@/components/chat/activity/ToolIcon";
import { callMeta, callTargetChip, failureLine, type WorkStep } from "@/lib/format/activity";
import { useOpen } from "@/lib/format/openState";
import { useDict } from "@/i18n";
import type { AttributionState } from "@/hooks/relay/useMessageLog";

interface WorkStepRowProps {
  step: WorkStep;
  /** Draws the line down to the next step. */
  connected: boolean;
  /** The step the turn is on right now — the one in the foreground. */
  current: boolean;
  /** The block is running, so a step that lands animates in. */
  live: boolean;
  attributionByToolUseId: Record<string, AttributionState>;
  cwd: string | null;
  onCopy: (text: string) => void;
  onOpenPath?: (path: string) => void;
}

/** Reasoning with more than this much text can be opened; shorter fits as is. */
const SHORT_THOUGHT = 140;

/**
 * One step of a turn's timeline: a marker, the step's line, and for a tool
 * step the chips of what it acted on. The marker is a dot for reasoning and
 * the call's own icon for a tool; a thin rule joins each marker to the next.
 * Colour follows state, not kind — the current step is in the foreground, the
 * finished ones recede, and only a failure is tinted.
 */
export const WorkStepRow = memo(function WorkStepRow({ step, connected, current, live, attributionByToolUseId, cwd, onCopy, onOpenPath }: WorkStepRowProps) {
  const dict = useDict();
  const work = dict.chat.activity.work;
  const [detailOpen, toggleDetail] = useOpen(`step:${step.id}`);
  const tone = step.kind === "tool" && step.failed ? "text-text-faint" : current ? "text-muted-foreground" : "text-text-faint";

  return (
    <li className={cn("relative flex gap-2 pb-2", live && "animate-step-in")}>
      {connected && <span aria-hidden className="absolute -bottom-0.5 left-[6.5px] top-5 w-px bg-border" />}
      <span aria-hidden className={cn("relative flex h-5 w-3.5 shrink-0 items-center justify-center", step.kind === "tool" && step.failed ? "text-destructive" : tone)}>
        {step.kind === "think" ? <span className="size-[5px] rounded-full bg-current opacity-60" /> : <ToolIcon call={step.calls[0]} className="size-3.5" />}
      </span>
      {step.kind === "think" ? (
        <ThoughtText id={step.id} text={step.text} running={step.running} tone={tone} />
      ) : (
        <div className="min-w-0 flex-1">
          <div className="flex min-h-5 items-center gap-2 leading-5">
            <button
              type="button"
              onClick={toggleDetail}
              aria-expanded={detailOpen}
              aria-label={`${(step.running ? work.steps[step.verb].ing : work.steps[step.verb].past)} — ${work.stepDetails}`}
              className={cn("flex cursor-pointer items-center gap-1 text-left transition-colors hover:text-foreground", tone)}
            >
              <Shimmer active={step.running}>{step.running ? work.steps[step.verb].ing : work.steps[step.verb].past}</Shimmer>
              <ChevronRight className={cn("size-3 shrink-0 transition-transform", detailOpen && "rotate-90")} aria-hidden />
            </button>
            <StepMeta step={step} />
          </div>
          <TargetChips
            stepId={step.id}
            targets={step.calls.map(callTargetChip)}
            failedCallIds={new Set(step.calls.filter((call) => call.isError && !call.aborted).map((call) => call.id))}
            onOpenPath={onOpenPath}
          />
          <FailureLine step={step} />
          {detailOpen && (
            <div className="mt-1.5 flex flex-col gap-px border border-border bg-border-soft">
              {step.calls.map((call) => (
                <ToolCallRow
                  key={call.id}
                  call={call}
                  attribution={call.toolUseId ? attributionByToolUseId[call.toolUseId] : undefined}
                  cwd={cwd}
                  onCopy={onCopy}
                  onOpenPath={onOpenPath}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
});

/** A line of reasoning. Long ones are cut to two lines and open on click. */
function ThoughtText({ id, text, running, tone }: { id: string; text: string; running: boolean; tone: string }) {
  const [open, toggle] = useOpen(`think:${id}`);
  const long = text.length > SHORT_THOUGHT || text.includes("\n");
  const body = <span className={cn("block whitespace-pre-wrap text-left", !open && "line-clamp-2")}>{text}</span>;
  return (
    <div className={cn("min-w-0 flex-1 leading-5", tone)}>
      {long ? (
        <button type="button" onClick={toggle} aria-expanded={open} className="block w-full cursor-pointer text-left transition-colors hover:text-foreground">
          {body}
        </button>
      ) : (
        <Shimmer active={running} className="whitespace-normal">
          {text}
        </Shimmer>
      )}
    </div>
  );
}

/** The right-hand detail of a finished step: what its one call reported, or
 * that it failed — with the exit code when exactly one call did (a command
 * and its retry). Several failures say only that; each call's own detail is
 * on its row. */
function StepMeta({ step }: { step: Extract<WorkStep, { kind: "tool" }> }) {
  const activity = useDict().chat.activity;
  if (step.running) return null;
  if (step.failed) {
    const failedCalls = step.calls.filter((call) => call.isError && !call.aborted);
    const only = failedCalls.length === 1 ? callMeta(failedCalls[0], activity) : undefined;
    return <span className="whitespace-nowrap font-mono text-xs text-destructive">{only?.kind === "error" ? only.text : activity.callFailed}</span>;
  }
  if (step.calls.length !== 1) return null;
  const meta = callMeta(step.calls[0], activity);
  // A change's `+a −r` is already on its chip.
  return meta?.kind === "text" ? <span className="whitespace-nowrap font-mono text-xs text-text-faint">{meta.text}</span> : null;
}

/** The first useful line of why a step failed, under its chips. */
function FailureLine({ step }: { step: Extract<WorkStep, { kind: "tool" }> }) {
  const line = step.calls.map(failureLine).find((text) => text !== "");
  if (!step.failed || !line) return null;
  return <p className="mt-1.5 truncate bg-destructive/10 px-2.5 py-1.5 font-mono text-xs text-destructive">{line}</p>;
}
