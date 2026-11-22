// Two bot pages open as tabs of their own: the bot templates (one tab per
// profile) and a bot's settings (one per bot). Their ids are reserved so
// nothing mistakes them for a session on the relay: they have no
// conversation, connection or dock.

const TEMPLATES_TAB_PREFIX = "bot-templates:";
/** The tab's id before it became the templates: a tab restored from then
 * still opens, as the templates. */
const LEGACY_NEW_BOT_TAB_PREFIX = "new-bot:";
const BOT_SETTINGS_TAB_PREFIX = "bot-settings:";

export function botTemplatesTabId(profileId: string): string {
  return `${TEMPLATES_TAB_PREFIX}${profileId}`;
}

export function isBotTemplatesTab(tabId: string): boolean {
  return tabId.startsWith(TEMPLATES_TAB_PREFIX) || tabId.startsWith(LEGACY_NEW_BOT_TAB_PREFIX);
}

export function botSettingsTabId(botId: string): string {
  return `${BOT_SETTINGS_TAB_PREFIX}${botId}`;
}

/** The bot a settings tab is for, or `undefined` for any other tab. */
export function settingsTabBotId(tabId: string): string | undefined {
  return tabId.startsWith(BOT_SETTINGS_TAB_PREFIX) ? tabId.slice(BOT_SETTINGS_TAB_PREFIX.length) : undefined;
}

/** A bot page (templates or settings): a tab with no session behind it. */
export function isBotPageTab(tabId: string): boolean {
  return isBotTemplatesTab(tabId) || settingsTabBotId(tabId) !== undefined;
}
