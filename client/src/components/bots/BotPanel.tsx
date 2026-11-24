import { useEffect, useMemo, useState } from "react";
import { Ban, Check, ChevronDown, Play, Settings, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Mascot } from "@/components/bots/Mascot";
import { BotTaskDetail } from "@/components/bots/BotTaskDetail";
import { useRoomChannel } from "@/hooks/sala/useRoomChannel";
import { useDict, useLocale } from "@/i18n";
import { removeSchedule, runScheduleNow, setSchedulePaused } from "@/lib/bots/botClient";
import { onPanelSettings, takePanelSettings } from "@/lib/bots/botSettingsRequest";
import { onPanelTask, takePanelTask } from "@/lib/bots/botTaskRequest";
import { BotSettings } from "@/components/bots/BotSettings";
import { botStatusLine, shortWhen } from "@/lib/bots/botStatusLine";
import { TASK_GROUPS, taskGroup, type BotSchedule, type BotTask, type BotTaskStatus, type BotView } from "@/lib/bots/botTypes";
import { mascotStateOf } from "@/lib/bots/mascot";
import type { Profile } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

interface BotPanelProps {
  profile: Profile;
  /** The bot's room (its conversation's session id). */
  roomId: string;
  /** Opens a session of the profile (an agent of a task) as a tab. */
  onOpenSession: (sessionId: string, title: string | null) => void;
}

/**
 * A bot's side panel: who it is and how it is doing, its task list grouped by
 * status (what needs the person first), and its automations. A task opens in
 * place, with its question answerable right there. Everything comes from the
 * bot's room channel, so it stays live while the panel is open.
 */
export function BotPanel({ profile, roomId, onOpenSession }: BotPanelProps) {
  const channel = useRoomChannel(profile, roomId);
  if (!channel.bot) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="md" />
      </div>
    );
  }
  return <BotPanelView profile={profile} bot={channel.bot} onOpenSession={onOpenSession} />;
}

/** The panel's content for a bot already known: what the channel feeds, and
 * what the stories draw. Besides the task list it opens, in place, one task
 * or the bot's settings; each comes back to the list. */
export function BotPanelView({
  profile,
  bot,
  onOpenSession,
  initialTask = null,
  initialSettings = false,
  settingsInitial,
}: {
  profile: Profile;
  bot: BotView;
  onOpenSession: (sessionId: string, title: string | null) => void;
  initialTask?: number | null;
  initialSettings?: boolean;
  /** The settings' soul and memory, instead of asking the relay (the stories). */
  settingsInitial?: Parameters<typeof BotSettings>[0]["initial"];
}) {
  // A task asked for from its conversation (a line of it) opens in place,
  // whether the panel mounts for it or is already open.
  const [requestedTask] = useState(() => takePanelTask(bot.roomId));
  const [openTask, setOpenTask] = useState<number | null>(requestedTask ?? initialTask);
  // Settings asked for from elsewhere (the sidebar's menu) before this
  // mounted, or while it is open. Both pending at mount: the task wins, as
  // it does when it arrives while the settings are open.
  const [settings, setSettings] = useState(() => {
    const asked = takePanelSettings(bot.roomId);
    return initialSettings || (asked && requestedTask === undefined);
  });
  useEffect(
    () =>
      onPanelSettings(bot.roomId, () => {
        if (takePanelSettings(bot.roomId)) setSettings(true);
      }),
    [bot.roomId],
  );
  useEffect(
    () =>
      onPanelTask(bot.roomId, () => {
        const n = takePanelTask(bot.roomId);
        if (n === undefined) return;
        setSettings(false);
        setOpenTask(n);
      }),
    [bot.roomId],
  );
  const task = openTask === null ? undefined : bot.tasks.find((each) => each.n === openTask);
  // A task no longer in the list (an old line's) shows the list — and is
  // forgotten, so it can't pop open by itself if that number comes back.
  const missing = openTask !== null && task === undefined;
  useEffect(() => {
    if (missing) setOpenTask(null);
  }, [missing]);
  const body = settings ? (
    <BotSettings profile={profile} bot={bot} onBack={() => setSettings(false)} initial={settingsInitial} />
  ) : task ? (
    <BotTaskDetail profile={profile} bot={bot} task={task} onBack={() => setOpenTask(null)} onOpenSession={onOpenSession} />
  ) : (
    <ScrollArea className="min-h-0 flex-1">
      <TaskList bot={bot} onOpen={setOpenTask} />
    </ScrollArea>
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bot-panel">
      <BotHeader bot={bot} settingsOpen={settings} onSettings={() => setSettings((open) => !open)} />
      {body}
      {!task && !settings && <Automations profile={profile} bot={bot} />}
    </div>
  );
}

function BotHeader({ bot, settingsOpen, onSettings }: { bot: BotView; settingsOpen: boolean; onSettings: () => void }) {
  const dict = useDict();
  const { locale } = useLocale();
  const line = botStatusLine(bot, dict, (at) => shortWhen(at, locale));
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-3">
      <Mascot mascot={bot.mascot} state={mascotStateOf(bot)} size={48} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{bot.name}</span>
        <span className={cn("truncate font-mono text-[11px]", line.tone === "attention" ? "text-primary" : line.tone === "fail" ? "text-destructive" : "text-text-faint")}>{line.text}</span>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={dict.bots.menu.settings} title={dict.bots.menu.settings} aria-pressed={settingsOpen} onClick={onSettings}>
        <Settings className="size-3.5" />
      </Button>
    </div>
  );
}

export function TaskStatusIcon({ status }: { status: BotTaskStatus }) {
  const dict = useDict();
  const label = dict.bots.task.status[status];
  if (status === "needs_you") return <span role="img" aria-label={label} className="mx-[3px] size-1.5 shrink-0 rounded-full bg-primary" />;
  if (status === "working") return <Spinner size="sm" label={label} role="img" />;
  if (status === "done") return <Check aria-label={label} className="size-3 shrink-0 text-text-faint" />;
  if (status === "canceled") return <Ban aria-label={label} className="size-3 shrink-0 text-text-faint" />;
  return <span role="img" aria-label={label} className="mx-[2px] size-2 shrink-0 border border-text-faint" />;
}

function TaskList({ bot, onOpen }: { bot: BotView; onOpen: (n: number) => void }) {
  const dict = useDict();
  // Closed tasks start folded; the person opens them when they look back.
  const [folded, setFolded] = useState<ReadonlySet<BotTaskStatus>>(() => new Set(["done"]));
  const groups = useMemo(() => {
    const byGroup = new Map<BotTaskStatus, BotTask[]>();
    for (const task of bot.tasks) {
      const group = taskGroup(task.status);
      byGroup.set(group, [...(byGroup.get(group) ?? []), task]);
    }
    return TASK_GROUPS.map((group) => ({ group, tasks: (byGroup.get(group) ?? []).sort((a, b) => b.updatedAt - a.updatedAt) })).filter((entry) => entry.tasks.length > 0);
  }, [bot.tasks]);

  if (groups.length === 0) {
    return (
      <div className="flex flex-col gap-1.5 px-4 py-6">
        <span className="font-mono text-xs text-muted-foreground">{dict.bots.panel.noTasks}</span>
        <span className="text-xs leading-relaxed text-text-faint">{dict.bots.panel.noTasksBody.replace("{name}", bot.name)}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col px-2 pb-3">
      {bot.conversationNeedsYou && (
        <p className="mx-1 mt-3 flex items-center gap-2 border border-primary/40 px-2 py-1.5 text-xs text-primary">
          <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
          {dict.bots.panel.conversationNeedsYou}
        </p>
      )}
      {groups.map(({ group, tasks }) => {
        const isFolded = folded.has(group);
        return (
          <div key={group} className="mt-3">
            <RowButton
              tone="faint"
              aria-expanded={!isFolded}
              onClick={() =>
                setFolded((current) => {
                  const next = new Set(current);
                  if (!next.delete(group)) next.add(group);
                  return next;
                })
              }
              className={cn("h-[21px] gap-2 font-mono text-[11.5px] font-medium", group === "needs_you" && "text-primary hover:text-primary")}
            >
              <ChevronDown className={cn("-mr-1 size-2.5 shrink-0 transition-transform", isFolded && "-rotate-90")} aria-hidden />
              <span>{dict.bots.panel.groups[group as keyof typeof dict.bots.panel.groups]}</span>
              <span aria-hidden className="min-w-0 flex-1 border-t border-dashed border-border" />
              <span className="min-w-[2ch] text-right">{tasks.length}</span>
            </RowButton>
            {!isFolded &&
              tasks.map((task) => (
                <RowButton key={task.n} size="auto" className="min-h-[30px] gap-2 py-1" onClick={() => onOpen(task.n)}>
                  <TaskStatusIcon status={task.status} />
                  <span className="shrink-0 font-mono text-[11px] text-text-faint">#{task.n}</span>
                  <span className={cn("min-w-0 flex-1 truncate", task.status === "canceled" && "line-through")}>{task.title}</span>
                  {task.status === "needs_you" && <span className="shrink-0 font-mono text-[10.5px] text-primary">{dict.bots.task.status.needs_you}</span>}
                </RowButton>
              ))}
          </div>
        );
      })}
    </div>
  );
}

function Automations({ profile, bot }: { profile: Profile; bot: BotView }) {
  const dict = useDict();
  const { locale } = useLocale();
  const [error, setError] = useState(false);
  const act = (work: Promise<void>): void => {
    setError(false);
    work.catch(() => setError(true));
  };
  return (
    <div className="shrink-0 border-t border-border px-2 py-2">
      <div className="flex items-center gap-2 px-2 pb-1 font-mono text-[11.5px] font-medium text-text-faint">
        <span>{dict.bots.panel.automations}</span>
        <span aria-hidden className="min-w-0 flex-1 border-t border-dashed border-border" />
        <span>{bot.schedules.length}</span>
      </div>
      {bot.schedules.length === 0 && <p className="px-2 py-1 text-xs leading-relaxed text-text-faint">{dict.bots.panel.noAutomations.replace("{name}", bot.name)}</p>}
      {bot.schedules.map((schedule) => (
        <ScheduleRow
          key={schedule.id}
          schedule={schedule}
          when={(at) => shortWhen(at, locale)}
          onToggle={(on) => act(setSchedulePaused(profile, bot.id, schedule.id, !on))}
          onRun={() => act(runScheduleNow(profile, bot.id, schedule.id))}
          onRemove={() => act(removeSchedule(profile, bot.id, schedule.id))}
        />
      ))}
      {error && <p className="px-2 pt-1 text-xs text-destructive">{dict.bots.panel.actionFailed}</p>}
    </div>
  );
}

function ScheduleRow({ schedule, when, onToggle, onRun, onRemove }: { schedule: BotSchedule; when: (at: number) => string; onToggle: (on: boolean) => void; onRun: () => void; onRemove: () => void }) {
  const dict = useDict();
  const last = schedule.runs[schedule.runs.length - 1] as BotSchedule["runs"][number] | undefined;
  const meta = schedule.running
    ? dict.bots.panel.running
    : schedule.paused
      ? dict.bots.panel.paused
      : schedule.nextRunAt !== undefined
        ? dict.bots.panel.nextRun.replace("{time}", when(schedule.nextRunAt))
        : "";
  return (
    <div className="group flex min-h-[30px] items-center gap-2 px-2 text-[13px]" data-testid="bot-schedule">
      <Switch checked={!schedule.paused} onCheckedChange={onToggle} aria-label={schedule.paused ? dict.bots.panel.resume : dict.bots.panel.pause} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate", schedule.paused ? "text-text-faint" : "text-foreground/90")}>{schedule.name}</span>
        <span className="truncate font-mono text-[10.5px] text-text-faint">
          {meta}
          {last && ` · ${dict.bots.panel.lastRun[last.outcome]}`}
        </span>
      </span>
      {schedule.running ? (
        <Spinner size="sm" label={dict.bots.panel.running} role="img" />
      ) : (
        <Button variant="quiet" size="icon-xs" aria-label={dict.bots.panel.runNow} title={dict.bots.panel.runNow} onClick={onRun}>
          <Play />
        </Button>
      )}
      <Button variant="quiet" size="icon-xs" aria-label={dict.bots.panel.remove} title={dict.bots.panel.remove} onClick={onRemove}>
        <Trash2 />
      </Button>
    </div>
  );
}
