import { useSyncExternalStore } from "react";
import { getRevokedProfiles, isProfileRevoked, subscribeProfileRevocation } from "@/lib/profiles/profileRevocation";

/** Reactive read of whether `profileId`'s connection was permanently
 * revoked — re-renders whenever any of the four reconnect loops (chat,
 * sessions/watch, terminal, files) marks it, or it's cleared (profile
 * removed/re-paired). */
export function useProfileRevoked(profileId: string): boolean {
  return useSyncExternalStore(
    subscribeProfileRevocation,
    () => isProfileRevoked(profileId),
  );
}

/** Reactive read of every revoked profile — for the profile switcher, which
 * badges the whole list at once and so cannot subscribe per id: a per-id
 * boolean snapshot only re-renders when that one profile flips. */
export function useRevokedProfiles(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeProfileRevocation, getRevokedProfiles);
}
