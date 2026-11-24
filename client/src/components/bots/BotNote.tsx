import { Ban, CalendarClock, CheckCheck, CircleSlash, Forward, MessageCircleQuestion, MessageSquareReply, Sparkles, type LucideIcon } from "lucide-react";
import { useDict } from "@/i18n";
import type { Dictionary } from "@/i18n/dictionary";
import { fillTemplate } from "@/lib/bots/botActivity";

/** What a relay turn's label says, as the note shows it. */
function noteOf(label: string, schedule: boolean, dict: Dictionary): { Icon: LucideIcon; text: string } {
  const turn = dict.bots.turn;
  if (schedule) return { Icon: CalendarClock, text: fillTemplate(turn.schedule, { name: label }) };
  const answer = /^answer:(\d+)$/.exec(label);
  if (answer) return { Icon: MessageSquareReply, text: turn.answer.replace("{n}", answer[1]) };
  const cancel = /^cancel:(\d+)$/.exec(label);
  if (cancel) return { Icon: Ban, text: turn.canceled.replace("{n}", cancel[1]) };
  // Another bot's message: its name is the rest of the label, colons and all.
  const peer = /^peer_(ask|answer|noanswer):(.+)$/s.exec(label);
  if (peer) {
    const [, kind, name] = peer;
    if (kind === "ask") return { Icon: MessageCircleQuestion, text: fillTemplate(turn.peerAsk, { name }) };
    if (kind === "answer") return { Icon: MessageSquareReply, text: fillTemplate(turn.peerAnswer, { name }) };
    return { Icon: CircleSlash, text: fillTemplate(turn.peerNoAnswer, { name }) };
  }
  const task = /^peer_(handoff|closed):(\d+):(.+)$/s.exec(label);
  if (task) {
    const [, kind, n, name] = task;
    return { Icon: kind === "handoff" ? Forward : CheckCheck, text: fillTemplate(kind === "handoff" ? turn.peerHandoff : turn.peerClosed, { name, n }) };
  }
  return { Icon: Sparkles, text: turn.created };
}

/** Where a bot's relay turn starts in its conversation: a schedule firing,
 * its creation, the person's answer to one of its tasks, a task they
 * canceled, or a message from another bot (a question, an answer, a task
 * handed over or closed). A note, never a bubble: nobody typed it. */
export function BotNote({ schedule, label }: { schedule: boolean; label: string }) {
  const dict = useDict();
  const { Icon, text } = noteOf(label, schedule, dict);
  return (
    <p className="flex items-center gap-1.5 font-mono text-[11px] text-text-faint">
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </p>
  );
}
