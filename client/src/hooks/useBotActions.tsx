import { useEffect, useMemo, useRef } from "react";
import type { BotsSectionActions } from "@/components/bots/BotsSection";
import type { useTabs } from "@/hooks/tabs/useTabs";
import { deleteBot, patchBot } from "@/lib/bots/botClient";
import { askPanelSettings, handleBotSettingsRequests, openBotSettings } from "@/lib/bots/botSettingsRequest";
import type { BotSummary } from "@/lib/bots/botTypes";
import { botByRoom, subscribeBotRemovals, subscribeBots } from "@/lib/bots/botsStore";
import { botTemplatesTabId } from "@/lib/bots/botTabs";
import { openNewBot } from "@/lib/bots/newBotRequest";
import type { Profile } from "@/lib/profiles/profiles";
import { trackBotAction } from "@/lib/telemetry/instrument";

interface UseBotActionsArgs {
  activeProfile: Profile;
  tabsState: ReturnType<typeof useTabs>;
  /** Closes the drawer on the platforms that have one. */
  onNavigated: () => void;
  /** Opens a pane of a tab's side panel (the bot's, for its settings). */
  openPane: (tabId: string, kind: "bot") => void;
}

/**
 * What the bots do in the shell: opening a bot's conversation (a tab marked
 * as a bot, so its side panel is the task list), one of its agents, the "New
 * bot" dialog, and the templates tab. A bot's settings are in its side
 * panel. The actions
 * object keeps one identity for the app's life (the sidebar is memoized).
 */
export function useBotActions({ activeProfile, tabsState, onNavigated, openPane }: UseBotActionsArgs): { botActions: BotsSectionActions; openBotTab: (profileId: string, bot: BotSummary) => void } {
  const latest = useRef({ activeProfile, tabsState, onNavigated, openPane });
  latest.current = { activeProfile, tabsState, onNavigated, openPane };

  /** The tab of a bot that no longer exists: its conversation. */
  const closeBotTabs = (bot: Pick<BotSummary, "id" | "roomId">): void => {
    latest.current.tabsState.closeTab(bot.roomId);
  };

  // However a bot goes (from here, its settings or another device), its tab
  // goes with it.
  useEffect(() => subscribeBotRemovals((removed) => removed.forEach(closeBotTabs)), []);

  // A bot's conversation opened before the bots were known (a push or a
  // search hit on a cold start, a tab restored without its mark) becomes the
  // bot's tab once the list says it is one.
  const tabIds = tabsState.tabs.map((tab) => tab.id).join(",");
  useEffect(() => {
    const mark = (): void => {
      const rooms = new Set(latest.current.tabsState.tabs.filter((tab) => botByRoom(tab.id) !== undefined).map((tab) => tab.id));
      if (rooms.size > 0) latest.current.tabsState.markBots(rooms);
    };
    mark();
    return subscribeBots(mark);
  }, [tabIds]);

  const botActions = useMemo<BotsSectionActions>(() => {
    const profile = (): Profile => latest.current.activeProfile;
    return {
      onSelectBot: (bot) => {
        trackBotAction("open_conversation");
        latest.current.tabsState.openTab(profile().id, bot.roomId, bot.name, false, false, true);
        latest.current.onNavigated();
      },
      onOpenAgent: (_bot, agentId, title) => {
        latest.current.tabsState.openTab(profile().id, agentId, title);
        latest.current.onNavigated();
      },
      onNewBot: (start, source) => {
        if (start === "templates") {
          latest.current.tabsState.openTab(profile().id, botTemplatesTabId(profile().id), null, true);
          latest.current.onNavigated();
          return;
        }
        openNewBot({ profileId: profile().id, ...(source ? { source } : {}) });
      },
      onBotSettings: (bot) => openBotSettings({ profileId: profile().id, botId: bot.id, roomId: bot.roomId, name: bot.name }),
      onTogglePaused: (bot) => {
        trackBotAction("pause_bot");
        // Its failure shows nothing (only the console), so it is no
        // `error_shown`.
        patchBot(profile(), bot.id, { paused: !bot.paused }).catch((error: unknown) => console.error("[anywh] failed to pause the bot", error));
      },
      onDeleteBot: (bot) => {
        trackBotAction("delete_bot");
        deleteBot(profile(), bot.id).then(
          () => closeBotTabs(bot),
          (error: unknown) => console.error("[anywh] failed to delete the bot", error),
        );
      },
    };
  }, []);

  // Settings live in the bot's side panel: whoever asks, its conversation
  // opens with the panel on them.
  useEffect(
    () =>
      handleBotSettingsRequests(({ profileId, roomId, name }) => {
        latest.current.tabsState.openTab(profileId, roomId, name, false, false, true);
        askPanelSettings(roomId);
        latest.current.openPane(roomId, "bot");
        latest.current.onNavigated();
      }),
    [],
  );

  return {
    botActions,
    openBotTab: (profileId, bot) => tabsState.openTab(profileId, bot.roomId, bot.name, false, false, true),
  };
}
