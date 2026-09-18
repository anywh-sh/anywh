import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCallCard } from "@/components/chat/ToolCallCard";
import { useDict } from "@/i18n";
import type { LogEntry, AttributionState } from "@/hooks/relay/useMessageLog";

export type ToolPair = {
  use: Extract<LogEntry, { kind: "tool-use" }>;
  result?: Extract<LogEntry, { kind: "tool-result" }>;
  attribution?: AttributionState;
};

interface ToolCallGroupProps {
  items: ToolPair[];
  /** Passed straight through to each card — see `ToolCallCard`. */
  cwd: string | null;
  onOpenPath?: (path: string) => void;
}

/** Collapses a contiguous sequence of silent tool calls (see
 * `MessageLog.tsx::buildRenderItems`) into a single item, same 2-level
 * pattern as Claude Desktop/VS Code: closed shows just the count, open
 * lists each `ToolCallCard` with its own individual collapse. */
export const ToolCallGroup = memo(function ToolCallGroup({ items, cwd, onOpenPath }: ToolCallGroupProps) {
  const dict = useDict();
  const [open, setOpen] = useState(false);
  const pending = items.some((item) => !item.result);
  const label = pending ? dict.chat.toolCall.usingTools : dict.chat.toolCall.usedTools;

  return (
    <div className="border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-hover"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-text-faint transition-transform", open && "rotate-90")} />
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {label.replace("{count}", String(items.length))}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-1 border-t border-border-soft p-1.5">
          {items.map((item) => (
            <ToolCallCard key={item.use.id} use={item.use} result={item.result} attribution={item.attribution} cwd={cwd} onOpenPath={onOpenPath} />
          ))}
        </div>
      )}
    </div>
  );
});
