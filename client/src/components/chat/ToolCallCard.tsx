import { memo } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useOpen } from "@/lib/format/openState";
import { useDict } from "@/i18n";
import type { ToolCallEntry } from "@/hooks/relay/useMessageLog";

interface ToolCallCardProps {
  call: ToolCallEntry;
}

const STATUS_MARK = { completed: "✓", in_progress: "▸", pending: "○" } as const;

/**
 * The card for a call that doesn't flow with the rest of the activity: a
 * plan, a checklist that updates. Everything else is drawn as an activity row
 * from its normalized `subject`/`outcome`, and a delegated task is not drawn
 * in the log at all (its subagent has a card at the end of the conversation).
 */
export const ToolCallCard = memo(function ToolCallCard({ call }: ToolCallCardProps) {
  const dict = useDict();
  const [open, toggle] = useOpen(call.id);
  const label = call.plan ? "plan" : call.subject?.kind === "task" ? call.subject.label : call.name;
  const inputEntries = Object.entries(call.input);

  return (
    <div className={cn("border bg-card", call.isError && !call.aborted ? "border-destructive/40" : "border-border")}>
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-hover">
        <ChevronRight className={cn("size-3.5 shrink-0 text-text-faint transition-transform", open && "rotate-90")} />
        <Badge variant="secondary">{call.name}</Badge>
        {label !== call.name && <span className="truncate font-mono text-[11.5px] text-muted-foreground">{label}</span>}
      </button>
      {open && (
        <div className="border-t border-border-soft px-2.5 py-2 text-xs">
          {call.plan ? (
            <ul className="flex flex-col gap-1">
              {call.plan.map((todo, index) => (
                <li key={index} className={cn("flex gap-2", todo.status === "completed" && "text-text-faint line-through")}>
                  <span className="shrink-0 font-mono">{STATUS_MARK[todo.status]}</span>
                  <span>{todo.content}</span>
                </li>
              ))}
            </ul>
          ) : (
            <>
              {inputEntries.length > 0 && (
                <div className="mb-2 flex flex-col gap-0.5 font-mono">
                  {inputEntries.map(([key, value]) => (
                    <div key={key} className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground">{key}:</span>
                      <span className="whitespace-pre-wrap break-all text-foreground">{typeof value === "string" ? value : JSON.stringify(value)}</span>
                    </div>
                  ))}
                </div>
              )}
              {call.done ? (
                <pre className={cn("overflow-x-auto whitespace-pre-wrap", call.isError ? "text-destructive" : "text-foreground")}>{call.content}</pre>
              ) : (
                <p className="text-muted-foreground">{dict.chat.activity.running}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});
