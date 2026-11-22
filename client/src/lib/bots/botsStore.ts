import { useSyncExternalStore } from "react";
import type { BotSummary } from "@/lib/bots/botTypes";

// The bots of each profile, as the relay last listed them on its
// `/sessions/watch` socket (`bots_state`). A small store rather than state in
// `App`: the sidebar is memoized and must get a stable value, and the tabs
// need to know which conversations are bots without a socket of their own.

const byProfile = new Map<string, readonly BotSummary[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly BotSummary[] = [];

function notify(): void {
  for (const listener of listeners) listener();
}

const removalListeners = new Set<(removed: readonly BotSummary[]) => void>();

export function setBots(profileId: string, bots: readonly BotSummary[]): void {
  const previous = byProfile.get(profileId);
  byProfile.set(profileId, bots);
  notify();
  // A bot gone from a list already seen was deleted (here or on another
  // device). The first list of a profile removes nothing.
  const removed = previous?.filter((bot) => !bots.some((each) => each.id === bot.id)) ?? [];
  if (removed.length > 0) for (const listener of removalListeners) listener(removed);
}

/** Calls `listener` with the bots that left a profile's list (deleted). */
export function subscribeBotRemovals(listener: (removed: readonly BotSummary[]) => void): () => void {
  removalListeners.add(listener);
  return () => removalListeners.delete(listener);
}

export function getBots(profileId: string): readonly BotSummary[] {
  return byProfile.get(profileId) ?? EMPTY;
}

/** The bot whose room (conversation) is `roomId`, in any profile. */
export function botByRoom(roomId: string): BotSummary | undefined {
  for (const bots of byProfile.values()) {
    const found = bots.find((bot) => bot.roomId === roomId);
    if (found) return found;
  }
  return undefined;
}

/** The bot with id `botId`, in any profile. */
export function botById(botId: string): BotSummary | undefined {
  for (const bots of byProfile.values()) {
    const found = bots.find((bot) => bot.id === botId);
    if (found) return found;
  }
  return undefined;
}

/** `botByRoom`, kept current as the list changes. */
export function useBotByRoom(roomId: string): BotSummary | undefined {
  return useSyncExternalStore(subscribeBots, () => botByRoom(roomId));
}

/** `botById`, kept current as the list changes. */
export function useBotById(botId: string): BotSummary | undefined {
  return useSyncExternalStore(subscribeBots, () => botById(botId));
}

export function subscribeBots(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBots(profileId: string): readonly BotSummary[] {
  return useSyncExternalStore(subscribeBots, () => getBots(profileId));
}

/** Test seam: forget everything. */
export function resetBotsStore(): void {
  byProfile.clear();
  notify();
}
