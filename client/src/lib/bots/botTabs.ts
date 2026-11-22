// Two bot pages open as tabs of their own, not dialogs: creating a bot (one
// tab per profile) and a bot's settings (one per bot). Their ids are reserved
// so nothing mistakes them for a session on the relay: they have no
// conversation, connection or dock.

const NEW_BOT_TAB_PREFIX = "new-bot:";
const BOT_SETTINGS_TAB_PREFIX = "bot-settings:";

export function newBotTabId(profileId: string): string {
  return `${NEW_BOT_TAB_PREFIX}${profileId}`;
}

export function isNewBotTab(tabId: string): boolean {
  return tabId.startsWith(NEW_BOT_TAB_PREFIX);
}

// Where a new-bot tab starts, when the caller asked: straight at the
// templates ("Templates"), past the first-bot presentation. Taken once: by
// the tab as it mounts, or by the tab already open, which is told.
const newBotStarts = new Map<string, "templates">();
const newBotStartListeners = new Map<string, Set<() => void>>();

export function setNewBotStart(profileId: string, start: "templates"): void {
  newBotStarts.set(profileId, start);
  for (const listener of newBotStartListeners.get(profileId) ?? []) listener();
}

/** Tells an open new-bot tab of `profileId` that a start was asked for. */
export function onNewBotStart(profileId: string, listener: () => void): () => void {
  const listeners = newBotStartListeners.get(profileId) ?? new Set<() => void>();
  listeners.add(listener);
  newBotStartListeners.set(profileId, listeners);
  return () => listeners.delete(listener);
}

export function takeNewBotStart(profileId: string): "templates" | undefined {
  const start = newBotStarts.get(profileId);
  newBotStarts.delete(profileId);
  return start;
}

export function botSettingsTabId(botId: string): string {
  return `${BOT_SETTINGS_TAB_PREFIX}${botId}`;
}

/** The bot a settings tab is for, or `undefined` for any other tab. */
export function settingsTabBotId(tabId: string): string | undefined {
  return tabId.startsWith(BOT_SETTINGS_TAB_PREFIX) ? tabId.slice(BOT_SETTINGS_TAB_PREFIX.length) : undefined;
}

/** A bot page (new bot or settings): a tab with no session behind it. */
export function isBotPageTab(tabId: string): boolean {
  return isNewBotTab(tabId) || settingsTabBotId(tabId) !== undefined;
}
