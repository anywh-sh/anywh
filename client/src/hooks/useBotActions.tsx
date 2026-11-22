import { useMemo, useRef, type ReactNode } from "react";
import { BotSettingsDialog } from "@/components/bots/BotSettingsDialog";
import type { BotsSectionActions } from "@/components/bots/BotsSection";
import type { useTabs } from "@/hooks/tabs/useTabs";
import { deleteBot, patchBot } from "@/lib/bots/botClient";
import { openBotDialog, useBotDialog } from "@/lib/bots/botDialogs";
import type { BotSummary } from "@/lib/bots/botTypes";
import { newBotTabId } from "@/lib/bots/newBotTab";
import { findProfile, type Profile } from "@/lib/profiles/profiles";

interface UseBotActionsArgs {
  activeProfile: Profile;
  tabsState: ReturnType<typeof useTabs>;
  /** Closes the drawer on the platforms that have one. */
  onNavigated: () => void;
}

/**
 * What the bots do in the shell: opening a bot's conversation (a tab marked
 * as a bot, so its side panel is the task list), one of its agents, the
 * new-bot tab and the bot settings dialog. The actions object keeps one identity for the app's life
 * (the sidebar is memoized); the dialogs are mounted once, wherever `App`
 * puts `dialogs`.
 */
export function useBotActions({ activeProfile, tabsState, onNavigated }: UseBotActionsArgs): { botActions: BotsSectionActions; dialogs: ReactNode; openBotTab: (profileId: string, bot: BotSummary) => void } {
  const latest = useRef({ activeProfile, tabsState, onNavigated });
  latest.current = { activeProfile, tabsState, onNavigated };

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
      onNewBot: () => {
        latest.current.tabsState.openTab(profile().id, newBotTabId(profile().id), null, true);
        latest.current.onNavigated();
      },
      onBotSettings: (bot) => openBotDialog({ kind: "settings", profileId: profile().id, botId: bot.id }),
      onTogglePaused: (bot) => {
        patchBot(profile(), bot.id, { paused: !bot.paused }).catch((error: unknown) => console.error("[anywh] failed to pause the bot", error));
      },
      onDeleteBot: (bot) => {
        deleteBot(profile(), bot.id).then(
          () => latest.current.tabsState.closeTab(bot.roomId),
          (error: unknown) => console.error("[anywh] failed to delete the bot", error),
        );
      },
    };
  }, []);

  const dialog = useBotDialog();
  const dialogProfile = dialog ? findProfile(dialog.profileId) : undefined;
  const dialogs = (
    <>
      {dialogProfile && dialog?.kind === "settings" && (
        <BotSettingsDialog
          profile={dialogProfile}
          botId={dialog.botId}
          open
          onOpenChange={(open) => {
            if (!open) openBotDialog(null);
          }}
          onDeleted={(roomId) => tabsState.closeTab(roomId)}
        />
      )}
    </>
  );

  return {
    botActions,
    dialogs,
    openBotTab: (profileId, bot) => tabsState.openTab(profileId, bot.roomId, bot.name, false, false, true),
  };
}
