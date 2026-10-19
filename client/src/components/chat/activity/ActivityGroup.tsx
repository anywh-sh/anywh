import { memo } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/components/chat/Shimmer";
import { Elapsed, formatElapsed } from "@/components/chat/activity/Elapsed";
import { ToolCallRow } from "@/components/chat/activity/ToolCallRow";
import { ToolIcon } from "@/components/chat/activity/ToolIcon";
import { groupBatch, groupDuration, groupStatus } from "@/lib/format/activity";
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
 * A run of tool calls as one discreet line — the icons of the last calls and
 * a count, "Using 3 tools…" while the agent works and "Used 3 tools · 1
 * failed · 12s" after — that grows with every call without growing longer.
 * What each call did is one click away on its row. Closed by default; open,
 * it lists each call. The open state is keyed by the group's id (its first
 * call) and kept outside this component, so scrolling it out of the
 * virtualized list and back doesn't close it.
 */
export const ActivityGroup = memo(function ActivityGroup({ id, calls, attributionByToolUseId, cwd, onCopy, onOpenPath }: ActivityGroupProps) {
  const dict = useDict();
  const activity = dict.chat.activity;
  // Prefixed: the group shares its id with its first call, which keeps a
  // state of its own in the same store.
  const [open, toggle] = useOpen(`group:${id}`);
  const status = groupStatus(calls);
  const batch = groupBatch(calls);
  const startedAt = calls.find((call) => call.startedAt !== undefined)?.startedAt;
  const duration = groupDuration(calls);
  const counts = status.running ? activity.toolsRunning : activity.toolsUsed;
  const title = (status.count === 1 ? counts.one : counts.many).replace("{count}", String(status.count));

  return (
    <div className="text-sm text-text-faint">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full cursor-pointer items-center gap-2 py-0.5 text-left transition-colors hover:text-muted-foreground">
        <span className="flex shrink-0 items-center" aria-hidden>
          {calls.slice(-3).map((call, index) => (
            <span key={call.id} className={cn("flex size-5 items-center justify-center border border-border bg-background [&_svg]:size-3", index > 0 && "-ml-1")}>
              <ToolIcon call={call} />
            </span>
          ))}
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <Shimmer active={status.running}>{title}</Shimmer>
          {status.failed > 0 && (
            <span className="whitespace-nowrap font-mono text-[11px] text-destructive">{" "}· {status.failed === 1 ? activity.failedOne : activity.failedMany.replace("{count}", String(status.failed))}</span>
          )}
          {status.running && startedAt !== undefined ? (
            <span className="whitespace-nowrap font-mono text-[11px]">
              {" "}· <Elapsed startedAt={startedAt} />
            </span>
          ) : (
            duration !== undefined && <span className="whitespace-nowrap font-mono text-[11px]">{" "}· {formatElapsed(duration)}</span>
          )}
        </span>
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
      </button>

      {open && (
        <div className="mt-1.5 flex flex-col gap-px border border-border bg-border-soft">
          {batch && (
            <div className="flex items-baseline justify-between bg-card px-3 py-1.5 font-mono text-[10.5px] tracking-wide text-text-faint">
              <span>{fill(activity.batchHeader, batch.count)}</span>
              {batch.durationMs !== undefined ? (
                <span>{formatElapsed(batch.durationMs)}</span>
              ) : (
                startedAt !== undefined && status.running && <Elapsed startedAt={startedAt} />
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
