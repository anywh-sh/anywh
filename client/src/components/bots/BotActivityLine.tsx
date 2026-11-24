import { BookmarkMinus, BookmarkPlus, CalendarClock, CalendarCog, CalendarX, Forward, ListChecks, ListPlus, ListTodo, MessageCircleQuestion, MessagesSquare, Sparkles, Users, Workflow, type LucideIcon } from "lucide-react";
import { useDict } from "@/i18n";
import type { BotActivity } from "@/lib/bots/botActivity";
import { cn } from "@/lib/utils";

const ICONS: Record<BotActivity["kind"], LucideIcon> = {
  created: ListPlus,
  updated: ListChecks,
  asked: MessageCircleQuestion,
  delegated: Workflow,
  remembered: BookmarkPlus,
  forgot: BookmarkMinus,
  soul: Sparkles,
  scheduled: CalendarClock,
  scheduleChanged: CalendarCog,
  scheduleRemoved: CalendarX,
  status: ListTodo,
  peers: Users,
  askedBot: MessagesSquare,
  handedOff: Forward,
};

/**
 * One thing a bot did with its own tools (a task, its memory, a schedule),
 * as a compact line of its conversation: verb in the past, what it acted on
 * after. The full story lives in the task list; this only marks where in the
 * conversation it happened.
 */
export function BotActivityLine({ activity }: { activity: BotActivity }) {
  const dict = useDict();
  const Icon = ICONS[activity.kind];
  const verb = dict.bots.activity[activity.kind].replace("{n}", "n" in activity && activity.n !== undefined ? String(activity.n) : "").replace("{name}", "name" in activity ? activity.name : "");
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground", activity.kind === "asked" && "text-primary")}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">{verb}</span>
      {activity.text && <span className="min-w-0 truncate text-foreground/80">{activity.text}</span>}
    </p>
  );
}
