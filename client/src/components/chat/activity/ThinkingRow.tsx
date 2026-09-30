import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Elapsed } from "@/components/chat/activity/Elapsed";
import { useOpen } from "@/lib/format/openState";
import { pickThinkingWord } from "@/lib/format/thinkingWords";
import { useDict } from "@/i18n";
import type { LogEntry } from "@/hooks/relay/useMessageLog";

type ThinkingEntry = Extract<LogEntry, { kind: "thinking" }>;

/**
 * A reasoning block. Running: one of the playful working verbs (drawn once
 * per block, so it doesn't change while you read it) and the time so far.
 * Finished: "Thought for Ns", or just "Thought" when no time was reported.
 * The arrow and the body exist only when the block carries text — many
 * models report that they reasoned without saying what about.
 */
export const ThinkingRow = memo(function ThinkingRow({ entry }: { entry: ThinkingEntry }) {
  const dict = useDict();
  const [open, toggle] = useOpen(entry.id);
  // Lazy state, not `useMemo`: a verb that re-rolled on a re-render would
  // flicker under the reader.
  const [word] = useState(() => pickThinkingWord(dict.chat.turn.workingWords));
  const hasText = entry.text.trim() !== "";
  const seconds = entry.startedAt !== undefined && entry.endedAt !== undefined ? Math.max(0, Math.round((entry.endedAt - entry.startedAt) / 1000)) : undefined;

  const label = entry.running
    ? `${word}…`
    : seconds !== undefined
      ? dict.chat.activity.thoughtFor.replace("{seconds}", String(seconds))
      : dict.chat.activity.thought;

  const header = (
    <>
      {entry.running && <span className="relative top-0.5 size-3 shrink-0 animate-spin self-start rounded-full border-2 border-border border-t-primary" aria-hidden />}
      <span>{label}</span>
      {entry.running && entry.startedAt !== undefined && <Elapsed startedAt={entry.startedAt} className="font-mono text-[11px]" />}
      {hasText && <ChevronRight className={cn("relative top-0.5 size-3 shrink-0 self-start transition-transform", open && "rotate-90")} />}
    </>
  );

  return (
    <div className="text-sm text-text-faint">
      {hasText ? (
        <button type="button" onClick={toggle} aria-expanded={open} className="flex cursor-pointer items-baseline gap-2 py-0.5 text-left transition-colors hover:text-muted-foreground">
          {header}
        </button>
      ) : (
        <div className="flex items-baseline gap-2 py-0.5">{header}</div>
      )}
      {open && hasText && <p className="mt-1 whitespace-pre-wrap border-l border-border-soft pl-3 text-xs leading-relaxed">{entry.text}</p>}
    </div>
  );
});
