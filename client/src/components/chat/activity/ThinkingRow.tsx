import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/components/chat/Shimmer";
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
  const seconds = entry.startedAt !== undefined && entry.endedAt !== undefined ? Math.max(0, Math.floor((entry.endedAt - entry.startedAt) / 1000)) : undefined;

  const label = entry.running
    ? `${word}…`
    : seconds !== undefined
      ? dict.chat.activity.thoughtFor.replace("{seconds}", String(seconds))
      : dict.chat.activity.thought;

  const header = (
    <>
      {hasText ? (
        <ChevronRight className={cn("size-3 shrink-0 self-center transition-transform", open && "rotate-90")} />
      ) : entry.running ? (
        <span className="size-3 shrink-0 animate-spin self-center rounded-full border-[1.5px] border-border border-t-foreground" aria-hidden />
      ) : null}
      <Shimmer active={entry.running}>{label}</Shimmer>
      {entry.running && entry.startedAt !== undefined && <Elapsed startedAt={entry.startedAt} className="font-mono text-[length:calc(11.5px*var(--chrome-scale))]" />}
    </>
  );

  return (
    <div className="text-[length:calc(14px*var(--chrome-scale))] text-text-faint">
      {hasText ? (
        <button type="button" onClick={toggle} aria-expanded={open} className="flex cursor-pointer items-center gap-2 py-1 text-left transition-colors hover:text-muted-foreground">
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-2 py-1">{header}</div>
      )}
      {open && hasText && <p className="mt-1 whitespace-pre-wrap border-l border-border-soft pl-3 text-xs leading-relaxed">{entry.text}</p>}
    </div>
  );
});
