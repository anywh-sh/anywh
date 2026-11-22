import { useSyncExternalStore } from "react";

// Which bot dialog is open, app-wide: the sidebar, a bot's panel and the iOS
// shell all open the same settings dialog, mounted once in `App`. (A new bot
// is a tab, not a dialog: see `newBotTab.ts`.)
export type BotDialog = { kind: "settings"; profileId: string; botId: string } | null;

let current: BotDialog = null;
const listeners = new Set<() => void>();

export function openBotDialog(dialog: BotDialog): void {
  current = dialog;
  for (const listener of listeners) listener();
}

export function useBotDialog(): BotDialog {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
