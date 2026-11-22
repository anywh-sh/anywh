// Opening a bot's settings from anywhere: the sidebar, a bot's panel and the
// iOS shell ask for it here, and the shell (`useBotActions`, which owns the
// tabs) opens the settings tab. A settings page is a tab, not a dialog: see
// `botTabs.ts`.

export interface BotSettingsRequest {
  profileId: string;
  botId: string;
  name: string;
}

let handler: ((request: BotSettingsRequest) => void) | null = null;

export function openBotSettings(request: BotSettingsRequest): void {
  handler?.(request);
}

/** Who opens the tab; one at a time (the app's shell). Returns the undo. */
export function handleBotSettingsRequests(next: (request: BotSettingsRequest) => void): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}
