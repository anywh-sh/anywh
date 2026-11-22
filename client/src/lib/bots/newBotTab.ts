// The new-bot flow is a tab of its own (one per profile), not a dialog: it
// sits beside the conversations while the person picks a template or writes
// what the bot should do, and becomes the bot's tab once it exists. Its id is
// reserved so nothing mistakes it for a session on the relay.

const NEW_BOT_TAB_PREFIX = "new-bot:";

export function newBotTabId(profileId: string): string {
  return `${NEW_BOT_TAB_PREFIX}${profileId}`;
}

export function isNewBotTab(tabId: string): boolean {
  return tabId.startsWith(NEW_BOT_TAB_PREFIX);
}
