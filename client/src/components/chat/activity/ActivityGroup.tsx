import { memo } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Elapsed, formatElapsed } from "@/components/chat/activity/Elapsed";
import { ToolCallRow } from "@/components/chat/activity/ToolCallRow";
import { groupBatch, summarizeGroup } from "@/lib/format/activity";
import { useOpen } from "@/lib/format/openState";
import { useDict } from "@/i18n";
import type { AttributionState, ToolCallEntry } from "@/hooks/relay/useMessageLog";

interface ActivityGroupProps {
  id: string;
  calls: ToolCallEntry[];
  attributionByToolUseId: Record<string, AttributionState>;
  cwd: string | null;
  onCopy: (text: string) => void;
  onOpenPath?: (path: string) => void;
}

function fill(template: string, count: number): string {
  return template.replace("{count}", String(count));
}

/**
 * A run of tool calls as one discreet sentence — no box, no icon — that
 * grows while the agent works: what finished in the past, what runs in the
 * gerund with a spinner. Closed by default; open, it lists each call. The
 * open state is keyed by the group's id (its first call) and kept outside
 * this component, so scrolling it out of the virtualized list and back
 * doesn't close it.
 */
export const ActivityGroup = memo(function ActivityGroup({ id, calls, attributionByToolUseId, cwd, onCopy, onOpenPath }: ActivityGroupProps) {
  const dict = useDict();
  const activity = dict.chat.activity;
  // Prefixed: the group shares its id with its first call, which keeps a
  // state of its own in the same store.
  const [open, toggle] = useOpen(`group:${id}`);
  const summary = summarizeGroup(calls, activity);
  const batch = groupBatch(calls);
  const startedAt = calls.find((call) => call.startedAt !== undefined)?.startedAt;

  return (
    <div className="text-sm text-text-faint">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full cursor-pointer items-baseline gap-2 py-0.5 text-left transition-colors hover:text-muted-foreground">
        {summary.running && <span className="relative top-0.5 size-3 shrink-0 animate-spin self-start rounded-full border-2 border-border border-t-primary" aria-hidden />}
        <span className="min-w-0">
          <span>{summary.text}</span>
          {summary.parallel > 0 && <span className="whitespace-nowrap font-mono text-[11px]"> · {fill(activity.parallelSuffix, summary.parallel)}</span>}
          {summary.failed > 0 && (
            <span className="whitespace-nowrap font-mono text-[11px] text-destructive"> · {summary.failed === 1 ? activity.failedOne : fill(activity.failedMany, summary.failed)}</span>
          )}
        </span>
        <ChevronRight className={cn("relative top-0.5 size-3 shrink-0 self-start transition-transform", open && "rotate-90")} />
      </button>

      {open && (
        <div className="mt-1.5 flex flex-col gap-px border border-border bg-border-soft">
          {batch && (
            <div className="flex items-baseline justify-between bg-card px-3 py-1.5 font-mono text-[10.5px] tracking-wide text-text-faint">
              <span>{fill(activity.batchHeader, batch.count)}</span>
              {batch.durationMs !== undefined ? (
                <span>{formatElapsed(batch.durationMs)}</span>
              ) : (
                startedAt !== undefined && summary.running && <Elapsed startedAt={startedAt} />
              )}
            </div>
          )}
          {calls.map((call) => (
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
  );
});
