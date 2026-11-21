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

export function setBots(profileId: string, bots: readonly BotSummary[]): void {
  byProfile.set(profileId, bots);
  notify();
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
