// The bot templates open as a tab of their own, one per profile. Its id is
// reserved so nothing mistakes it for a session on the relay: it has no
// conversation, connection or dock.

const TEMPLATES_TAB_PREFIX = "bot-templates:";

export function botTemplatesTabId(profileId: string): string {
  return `${TEMPLATES_TAB_PREFIX}${profileId}`;
}

export function isBotTemplatesTab(tabId: string): boolean {
  return tabId.startsWith(TEMPLATES_TAB_PREFIX);
}

/** A bot page: a tab with no session behind it. */
export function isBotPageTab(tabId: string): boolean {
  return isBotTemplatesTab(tabId);
}
