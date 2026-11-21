import { CalendarClock, MessageSquareReply, Sparkles } from "lucide-react";
import { useDict } from "@/i18n";

/** Where a bot's relay turn starts in its conversation: a schedule firing,
 * its creation, or the person's answer to one of its tasks. A note, never a
 * bubble: nobody typed it. */
export function BotNote({ schedule, label }: { schedule: boolean; label: string }) {
  const dict = useDict();
  const answer = /^answer:(\d+)$/.exec(label);
  const Icon = schedule ? CalendarClock : answer ? MessageSquareReply : Sparkles;
  const text = schedule ? dict.bots.turn.schedule.replace("{name}", label) : answer ? dict.bots.turn.answer.replace("{n}", answer[1]) : dict.bots.turn.created;
  return (
    <p className="flex items-center gap-1.5 font-mono text-[11px] text-text-faint">
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </p>
  );
}
