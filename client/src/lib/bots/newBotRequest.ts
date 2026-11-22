import { useSyncExternalStore } from "react";
import type { BotTemplateId } from "@/lib/bots/templates";

// Opening the "New bot" dialog from anywhere: the Bots heading's "+", the
// first-bot card, a template's card, the iOS drawer. One dialog for the app,
// over whatever is on screen; this is what it reads.

export interface NewBotRequest {
  profileId: string;
  /** Fills the dialog from a template. */
  templateId?: BotTemplateId;
  /** The tab it was opened from (the templates tab), which becomes the
   * bot's conversation once it exists. */
  fromTabId?: string;
}

let current: NewBotRequest | null = null;
const listeners = new Set<() => void>();

function emit(next: NewBotRequest | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function openNewBot(request: NewBotRequest): void {
  emit(request);
}

export function closeNewBot(): void {
  emit(null);
}

export function useNewBotRequest(): NewBotRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
