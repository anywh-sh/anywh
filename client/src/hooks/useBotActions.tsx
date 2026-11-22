import { useEffect, useMemo, useRef } from "react";
import type { BotsSectionActions } from "@/components/bots/BotsSection";
import type { useTabs } from "@/hooks/tabs/useTabs";
import { deleteBot, patchBot } from "@/lib/bots/botClient";
import { handleBotSettingsRequests, openBotSettings } from "@/lib/bots/botSettingsRequest";
import type { BotSummary } from "@/lib/bots/botTypes";
import { subscribeBotRemovals } from "@/lib/bots/botsStore";
import { botSettingsTabId, botTemplatesTabId } from "@/lib/bots/botTabs";
import { openNewBot } from "@/lib/bots/newBotRequest";
import type { Profile } from "@/lib/profiles/profiles";

interface UseBotActionsArgs {
  activeProfile: Profile;
  tabsState: ReturnType<typeof useTabs>;
  /** Closes the drawer on the platforms that have one. */
  onNavigated: () => void;
}

/**
 * What the bots do in the shell: opening a bot's conversation (a tab marked
 * as a bot, so its side panel is the task list), one of its agents, the "New
 * bot" dialog, and the two bot pages, each a tab: the templates, and a bot's
 * settings. The actions
 * object keeps one identity for the app's life (the sidebar is memoized).
 */
export function useBotActions({ activeProfile, tabsState, onNavigated }: UseBotActionsArgs): { botActions: BotsSectionActions; openBotTab: (profileId: string, bot: BotSummary) => void } {
  const latest = useRef({ activeProfile, tabsState, onNavigated });
  latest.current = { activeProfile, tabsState, onNavigated };

  /** Every tab of a bot that no longer exists: its conversation and its settings. */
  const closeBotTabs = (bot: Pick<BotSummary, "id" | "roomId">): void => {
    latest.current.tabsState.closeTab(bot.roomId);
    latest.current.tabsState.closeTab(botSettingsTabId(bot.id));
  };

  // However a bot goes (from here, its settings or another device), its tabs
  // go with it.
  useEffect(() => subscribeBotRemovals((removed) => removed.forEach(closeBotTabs)), []);

  const botActions = useMemo<BotsSectionActions>(() => {
    const profile = (): Profile => latest.current.activeProfile;
    return {
      onSelectBot: (bot) => {
        latest.current.tabsState.openTab(profile().id, bot.roomId, bot.name, false, false, true);
        latest.current.onNavigated();
      },
      onOpenAgent: (_bot, agentId, title) => {
        latest.current.tabsState.openTab(profile().id, agentId, title);
        latest.current.onNavigated();
      },
      onNewBot: (start) => {
        if (start === "templates") {
          latest.current.tabsState.openTab(profile().id, botTemplatesTabId(profile().id), null, true);
          latest.current.onNavigated();
          return;
        }
        openNewBot({ profileId: profile().id });
      },
      onBotSettings: (bot) => openBotSettings({ profileId: profile().id, botId: bot.id, name: bot.name }),
      onTogglePaused: (bot) => {
        patchBot(profile(), bot.id, { paused: !bot.paused }).catch((error: unknown) => console.error("[anywh] failed to pause the bot", error));
      },
      onDeleteBot: (bot) => {
        deleteBot(profile(), bot.id).then(
          () => closeBotTabs(bot),
          (error: unknown) => console.error("[anywh] failed to delete the bot", error),
        );
      },
    };
  }, []);

  // Settings open as a tab, whoever asks (the sidebar, a bot's panel).
  useEffect(
    () =>
      handleBotSettingsRequests(({ profileId, botId, name }) => {
        latest.current.tabsState.openTab(profileId, botSettingsTabId(botId), name);
        latest.current.onNavigated();
      }),
    [],
  );

  return {
    botActions,
    openBotTab: (profileId, bot) => tabsState.openTab(profileId, bot.roomId, bot.name, false, false, true),
  };
}
