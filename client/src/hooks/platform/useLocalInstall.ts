import { useSyncExternalStore } from "react";
import { getLocalInstallState, subscribeLocalInstall, type LocalInstallState } from "@/lib/install/localInstall";

/** Reactive read of the in-app install's state — the wizard is a pure
 * projection of it, same shape as `useProfileSetup`. */
export function useLocalInstall(): LocalInstallState {
  return useSyncExternalStore(subscribeLocalInstall, getLocalInstallState);
}
