import { useSyncExternalStore } from "react";
import type { BotTemplateId } from "@/lib/bots/templates";
import type { BotCreateFailure, BotCreateSource } from "@/lib/telemetry/events";
import { trackBotCreateEnded, trackBotCreateOpened, trackError, type BotCreateAttempt } from "@/lib/telemetry/instrument";

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
  /** Where it was opened from, for the creation funnel. */
  source?: BotCreateSource;
}

let current: NewBotRequest | null = null;
const listeners = new Set<() => void>();

function emit(next: NewBotRequest | null): void {
  current = next;
  for (const listener of listeners) listener();
}

// The dialog's current opening, counted from open to close: whether it
// ended with a bot, and what stood in the way if not.
let attempt: BotCreateAttempt | null = null;

function endAttempt(): void {
  if (attempt) trackBotCreateEnded(attempt);
  attempt = null;
}

export function openNewBot(request: NewBotRequest): void {
  // Opened again over itself: the earlier opening ended without a bot.
  endAttempt();
  attempt = { templateId: request.templateId, openedAt: Date.now(), gated: false, failedAttempts: 0 };
  trackBotCreateOpened(request.source ?? "other", request.templateId);
  emit(request);
}

export function closeNewBot(): void {
  endAttempt();
  emit(null);
}

/** The dialog showed the relay as too old for bots. */
export function noteBotCreateGated(): void {
  if (attempt) attempt.gated = true;
}

/** An attempt to create failed; the dialog stays open to try again. */
export function noteBotCreateFailed(reason: BotCreateFailure): void {
  trackError("bot_create_failed");
  if (!attempt) return;
  attempt.failedAttempts++;
  attempt.lastFailure = reason;
}

/** The bot exists. Called before the dialog closes. */
export function noteBotCreated(agentId: string, scheduleOn: boolean): void {
  if (attempt) attempt.created = { agentId, scheduleOn };
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
