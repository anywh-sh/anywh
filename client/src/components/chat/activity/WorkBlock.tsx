import { memo } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/components/chat/Shimmer";
import { Elapsed, formatElapsed } from "@/components/chat/activity/Elapsed";
import { WorkStepRow } from "@/components/chat/activity/WorkStepRow";
import type { WorkItem } from "@/lib/format/activity";
import { useWorkOpen } from "@/lib/format/openState";
import { useDict } from "@/i18n";
import type { AttributionState } from "@/hooks/relay/useMessageLog";

interface WorkBlockProps {
  item: WorkItem;
  attributionByToolUseId: Record<string, AttributionState>;
  cwd: string | null;
  onCopy: (text: string) => void;
  onOpenPath?: (path: string) => void;
}

/**
 * Everything the agent did in a turn before its answer, as one block that
 * starts straight at its own line — "Working 5s" while the turn runs, "Worked
 * for 48s" after — with no header of the turn above it. Under that line, the
 * timeline: reasoning and tool steps in the order they happened.
 *
 * Open while the turn runs and folded shortly after it ends, unless the user
 * opened or closed it themselves (`useWorkOpen`). The fold is instant: the
 * motion budget (`designVocabulary.test.ts`) keeps layout out of animation,
 * and a block's height is exactly that.
 */
export const WorkBlock = memo(function WorkBlock({ item, attributionByToolUseId, cwd, onCopy, onOpenPath }: WorkBlockProps) {
  const work = useDict().chat.activity.work;
  const [open, toggle] = useWorkOpen(`work:${item.id}`, item.running);
  const label = item.running ? work.working : item.durationMs !== undefined ? work.workedFor.replace("{time}", formatElapsed(item.durationMs)) : work.worked;
  const failed = item.failed === 1 ? work.failedOne : work.failedMany.replace("{count}", String(item.failed));
  const finished = !item.running && !item.interrupted;

  return (
    <section aria-busy={item.running} className="text-sm text-text-faint">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex cursor-pointer items-center gap-2 py-0.5 text-left transition-colors hover:text-muted-foreground">
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")} aria-hidden />
        <Shimmer active={item.running}>{label}</Shimmer>
        {item.running && item.startedAt !== undefined && <Elapsed startedAt={item.startedAt} className="font-mono text-xs" />}
        {item.failed > 0 && <span className="whitespace-nowrap font-mono text-xs text-destructive">· {failed}</span>}
      </button>

      {open && (item.steps.length > 0 || finished) && (
        <ol className="mt-1">
          {item.steps.map((step, index) => {
            const last = index === item.steps.length - 1;
            return (
              <WorkStepRow
                key={step.id}
                step={step}
                connected={!last || finished}
                current={item.running && last}
                live={item.running}
                attributionByToolUseId={attributionByToolUseId}
                cwd={cwd}
                onCopy={onCopy}
                onOpenPath={onOpenPath}
              />
            );
          })}
          {finished && (
            <li className="flex items-center gap-2">
              <span aria-hidden className="flex h-5 w-3.5 shrink-0 items-center justify-center text-diff-add">
                <Check className="size-3.5" strokeWidth={2.5} />
              </span>
              <span className="leading-5 text-muted-foreground">{work.done}</span>
            </li>
          )}
        </ol>
      )}
    </section>
  );
});
