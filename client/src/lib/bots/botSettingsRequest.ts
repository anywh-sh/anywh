// Opening a bot's settings from anywhere: the sidebar's menu and the iOS
// shell ask for it here. The shell (`useBotActions`, which owns the tabs)
// opens the bot's conversation with its side panel, and the panel — which
// may only mount once the pane opens — takes the request and shows the
// settings instead of the task list.

export interface BotSettingsRequest {
  profileId: string;
  botId: string;
  roomId: string;
  name: string;
}

let handler: ((request: BotSettingsRequest) => void) | null = null;

export function openBotSettings(request: BotSettingsRequest): void {
  handler?.(request);
}

/** Who opens the bot's tab and panel; one at a time (the app's shell).
 * Returns the undo. */
export function handleBotSettingsRequests(next: (request: BotSettingsRequest) => void): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

// Settings asked for a bot's panel, per room: taken once, by the panel as it
// mounts or by the panel already open, which is told.
const pending = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

export function askPanelSettings(roomId: string): void {
  pending.add(roomId);
  for (const listener of listeners.get(roomId) ?? []) listener();
}

export function takePanelSettings(roomId: string): boolean {
  return pending.delete(roomId);
}

export function onPanelSettings(roomId: string, listener: () => void): () => void {
  const set = listeners.get(roomId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(roomId, set);
  return () => set.delete(listener);
}
