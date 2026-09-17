import { useSyncExternalStore } from "react";
import { getProfileSetupState, subscribeProfileSetup, type ProfileSetupSnapshot } from "@/lib/profiles/profileSetup";

/** Reactive read of the profile-setup runner's current step and queue depth
 * — `ProfileSetupDialog` (the only consumer) is a pure projection of this,
 * same "read outside React, subscribe from a hook" shape as `useProfiles`/
 * `useProfileRevoked`. Mounting or unmounting the dialog never affects the
 * pipeline underneath: it keeps running against the module-level store in
 * `profileSetup.ts` regardless of who's watching. */
export function useProfileSetup(): ProfileSetupSnapshot {
  return useSyncExternalStore(subscribeProfileSetup, getProfileSetupState);
}
