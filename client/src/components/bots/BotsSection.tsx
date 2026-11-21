import { memo, useMemo, useState } from "react";
import { MessageSquare, Pause, Play, Plus, Settings, Trash2 } from "lucide-react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { RowButton } from "@/components/ui/row-button";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Mascot } from "@/components/bots/Mascot";
import { ContextMenuAnchor, useContextMenu } from "@/hooks/platform/useContextMenu";
import { useRoomChannel } from "@/hooks/sala/useRoomChannel";
import { lacksFeature, useRelayFeatures } from "@/hooks/relay/useRelayFeatures";
import { BotsRelayGate } from "@/components/bots/BotsRelayGate";
import { useDict, useLocale } from "@/i18n";
import { useBots } from "@/lib/bots/botsStore";
import { botStatusLine, shortWhen } from "@/lib/bots/botStatusLine";
import { mascotStateOf } from "@/lib/bots/mascot";
import type { BotSummary } from "@/lib/bots/botTypes";
import type { Profile } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

export interface BotsSectionActions {
  onSelectBot: (bot: BotSummary) => void;
  /** Opens one of the bot's agents as a tab. */
  onOpenAgent: (bot: BotSummary, agentId: string, title: string | null) => void;
  onNewBot: () => void;
  onBotSettings: (bot: BotSummary) => void;
  onTogglePaused: (bot: BotSummary) => void;
  onDeleteBot: (bot: BotSummary) => void;
}

interface BotsSectionProps extends BotsSectionActions {
  profile: Profile;
  /** The active tab's session id: the bot whose conversation (or agent) it
   * is opens its tree. */
  selectedSession: string | null;
}

/**
 * The bots of the active profile, one row each: the mascot, the name, and
 * what is going on in one line. The bot in focus opens a short tree under
 * its row: its conversation, then the agents at work for it.
 */
export const BotsSection = memo(function BotsSection({ profile, selectedSession, ...actions }: BotsSectionProps) {
  const dict = useDict();
  const bots = useBots(profile.id);
  // The bot whose tree is open: the one last picked, kept while one of its
  // agents is the active tab.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const selectedBot = bots.find((bot) => bot.roomId === selectedSession);
  const expanded = selectedBot?.id ?? expandedId;
  const relay = useRelayFeatures(profile, "bots");

  // A relay older than bots: say what it takes to have them, not "no bots".
  if (bots.length === 0 && lacksFeature(relay, "bots")) {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <BotsRelayGate profile={profile} relayVersion={relay.version} />
      </ScrollArea>
    );
  }

  if (bots.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 px-5 py-9 text-center">
        <span className="font-mono text-xs text-muted-foreground">{dict.bots.emptyTitle}</span>
        <span className="max-w-52 text-xs leading-relaxed text-text-faint">{dict.bots.emptyBody}</span>
        <Button type="button" variant="outline" size="xs" onClick={actions.onNewBot}>
          <Plus className="size-3" />
          {dict.bots.emptyCta}
        </Button>
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col px-2 pb-2">
        {bots.map((bot) => (
          <div key={bot.id}>
            <BotRow
              bot={bot}
              selected={bot.roomId === selectedSession}
              onSelect={() => {
                setExpandedId(bot.id);
                actions.onSelectBot(bot);
              }}
              actions={actions}
            />
            {expanded === bot.id && <BotTree profile={profile} bot={bot} selectedSession={selectedSession} actions={actions} />}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
});

function BotRow({ bot, selected, onSelect, actions }: { bot: BotSummary; selected: boolean; onSelect: () => void; actions: BotsSectionActions }) {
  const dict = useDict();
  const { locale } = useLocale();
  const menu = useContextMenu();
  const line = botStatusLine(bot, dict, (at) => shortWhen(at, locale));
  const state = mascotStateOf(bot);
  return (
    <div className="relative" onContextMenu={menu.onContextMenu}>
      <RowButton size="auto" selected={selected} mark="start" onClick={onSelect} className="gap-2.5 py-1.5" aria-label={bot.name}>
        <Mascot seed={bot.mascot.seed} state={state} size={24} badge />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate text-[length:calc(13px*var(--chrome-scale))]", selected ? "text-foreground" : "text-foreground/90")}>{bot.name}</span>
          <span
            className={cn(
              "truncate font-mono text-[length:calc(11px*var(--chrome-scale))]",
              line.tone === "attention" ? "text-primary" : line.tone === "fail" ? "text-destructive" : "text-text-faint",
            )}
          >
            {line.text}
          </span>
        </span>
      </RowButton>
      <DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
        <ContextMenuAnchor position={menu.position} />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => actions.onBotSettings(bot)}>
            <Settings />
            {dict.bots.menu.settings}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.onTogglePaused(bot)}>
            {bot.paused ? <Play /> : <Pause />}
            {bot.paused ? dict.bots.menu.resume : dict.bots.menu.pause}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              menu.setOpen(false);
              void confirmDialog(dict.bots.settings.deleteConfirm.replace("{name}", bot.name), {
                title: dict.bots.settings.delete,
                kind: "warning",
                okLabel: dict.common.delete,
                cancelLabel: dict.common.cancel,
              }).then((confirmed) => {
                if (confirmed) actions.onDeleteBot(bot);
              });
            }}
          >
            <Trash2 />
            {dict.bots.menu.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Under the bot in focus: its conversation, then its agents at work (from
 * its room's channel — one socket, for this bot only). */
function BotTree({ profile, bot, selectedSession, actions }: { profile: Profile; bot: BotSummary; selectedSession: string | null; actions: BotsSectionActions }) {
  const dict = useDict();
  const channel = useRoomChannel(profile, bot.roomId);
  const live = useMemo(
    () => channel.agents.filter((agent) => agent.role === "worker" && (agent.state === "working" || agent.state === "queued" || agent.state === "awaiting_user" || agent.state === "waiting")),
    [channel.agents],
  );
  return (
    <div className="ml-[19px] flex flex-col border-l border-border pl-1.5">
      <RowButton size="auto" className="h-7 gap-2" selected={selectedSession === bot.roomId} onClick={() => actions.onSelectBot(bot)}>
        <MessageSquare className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{dict.bots.conversation}</span>
      </RowButton>
      {live.length > 0 && (
        <span className="px-2 pt-1.5 pb-0.5 font-mono text-[length:calc(10.5px*var(--chrome-scale))] text-text-faint">
          {dict.bots.workers.replace("{count}", String(live.filter((agent) => agent.state === "working").length))}
        </span>
      )}
      {live.map((agent) => (
        <RowButton key={agent.agentId} size="auto" className="h-7 gap-2" selected={selectedSession === agent.agentId} onClick={() => actions.onOpenAgent(bot, agent.agentId, agent.title)}>
          {agent.state === "awaiting_user" ? (
            <span role="img" aria-label={dict.bots.task.worker.waiting} className="mx-[3px] size-1.5 shrink-0 rounded-full bg-primary" />
          ) : agent.state === "working" ? (
            <Spinner size="sm" label={dict.bots.task.worker.working} role="img" />
          ) : (
            <span aria-hidden className="mx-[3px] size-1.5 shrink-0 border border-text-faint" />
          )}
          <span className="truncate">{agent.title ?? agent.agentId.slice(0, 8)}</span>
        </RowButton>
      ))}
    </div>
  );
}
