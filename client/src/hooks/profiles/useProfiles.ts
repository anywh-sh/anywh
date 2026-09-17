import { useSyncExternalStore } from "react";
import { getProfiles, subscribeProfiles, type Profile } from "@/lib/profiles/profiles";

/** Reactive read of the profiles list — re-renders the component if
 * `setProfiles` is ever called (pairing flow, settings UI). Components that
 * render the list (switcher, sidebar, search, settings) should use this
 * instead of importing `getProfiles` directly. */
export function useProfiles(): Profile[] {
  return useSyncExternalStore(subscribeProfiles, getProfiles);
}
