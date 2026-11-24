import { ArrowUpRight, BookmarkMinus, BookmarkPlus, CalendarClock, CalendarCog, CalendarX, Forward, ListChecks, ListPlus, ListTodo, MessageCircleQuestion, MessagesSquare, Sparkles, Users, Workflow, type LucideIcon } from "lucide-react";
import { TextButton } from "@/components/ui/text-button";
import { useDict } from "@/i18n";
import { fillTemplate, type BotActivity } from "@/lib/bots/botActivity";
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
 * conversation it happened — and, for a line naming a task, is the way there:
 * clicking it opens that task in the side panel (`onOpenTask`). A question
 * ("Asked you about task #2") is the one the person most needs to reach, so
 * its arrow is always on; the others show it on hover.
 */
export function BotActivityLine({ activity, onOpenTask }: { activity: BotActivity; onOpenTask?: (n: number) => void }) {
  const dict = useDict();
  const Icon = ICONS[activity.kind];
  const n = "n" in activity ? activity.n : undefined;
  const verb = fillTemplate(dict.bots.activity[activity.kind], { n: n !== undefined ? String(n) : "", name: "name" in activity ? activity.name : "" });
  const asked = activity.kind === "asked";
  const content = (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">{verb}</span>
      {activity.text && <span className="min-w-0 truncate text-foreground/80">{activity.text}</span>}
    </>
  );
  if (n === undefined || !onOpenTask) {
    return <p className={cn("flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground", asked && "text-primary")}>{content}</p>;
  }
  const label = dict.bots.task.open.replace("{n}", String(n));
  return (
    <TextButton
      tone={asked ? "none" : "muted"}
      title={label}
      onClick={() => onOpenTask(n)}
      className={cn("group/activity flex w-full min-w-0 items-center gap-1.5 text-[12.5px]", asked && "text-primary hover:text-primary/80")}
    >
      {content}
      <ArrowUpRight className={cn("size-3.5 shrink-0 transition-opacity", asked ? "opacity-100" : "opacity-0 group-hover/activity:opacity-100 group-focus-visible/activity:opacity-100")} aria-hidden />
    </TextButton>
  );
}
