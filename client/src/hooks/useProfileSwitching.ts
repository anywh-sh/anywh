import type { Dispatch, SetStateAction } from "react";
import type { useTabs } from "@/hooks/tabs/useTabs";
import type { ProfileSetupSnapshot } from "@/lib/profiles/profileSetup";
import { addProfile, removeProfile } from "@/lib/profiles/profiles";
import { clearProfileRevoked, isProfileRevoked } from "@/lib/profiles/profileRevocation";
import { completeProfileSetup, dismissProfileSetup } from "@/lib/profiles/profileSetup";

interface UseProfileSwitchingArgs {
  setActiveProfileId: (id: string) => void;
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;
  openTab: ReturnType<typeof useTabs>["openTab"];
  setupSnapshot: ProfileSetupSnapshot;
}

/** The three ways the active profile changes: picking one in the sidebar,
 * and the two exits of `ProfileSetupDialog` (adopt the profile just
 * claimed, or keep the pre-existing one with the same account). */
export function useProfileSwitching({ setActiveProfileId, setDrawerOpen, openTab, setupSnapshot }: UseProfileSwitchingArgs): {
  handleProfileChange: (profileId: string) => void;
  handleSetupContinue: (profileId: string) => void;
  handleSetupUseExisting: (existingId: string) => void;
} {
  function handleProfileChange(profileId: string): void {
    setActiveProfileId(profileId);
    setDrawerOpen(false);
  }

  /** "Continuar para novo perfil" on `ProfileSetupDialog` — the only place
   * that ever switches to a profile `enqueueProfileSetup` just set up.
   * Order matters: `handleProfileChange` runs first so React has already
   * scheduled the render that makes `useTailnetSidecarOwner` reclaim the
   * tailnet-sidecar reference `profileSetup.ts` is about to hand over,
   * before `completeProfileSetup` releases it (with `HANDOVER_GRACE_MS` to
   * spare). `openTab` takes `profileId` explicitly rather than going through
   * `handleNewConversation` — that one reads `activeProfile.id` from its own
   * closure, which still has the old value in this same tick. */
  function handleSetupContinue(profileId: string): void {
    handleProfileChange(profileId);
    openTab(profileId, crypto.randomUUID(), null, true);
    completeProfileSetup();
  }

  /** "Ir para o perfil existente" on `ProfileSetupDialog`'s duplicate
   * notice — decision 4: normally just drops the freshly claimed duplicate
   * profile, but if the existing one was revoked, migrates the fresh
   * credentials onto its id first (`addProfile` replaces in place) so a
   * dismissed `RevokedProfileBanner` doesn't leave that profile stuck dead.
   * `removeProfile` refusing to empty the list is never a concern here — a
   * duplicate existing means there are already at least two profiles.
   * Ends the setup request via `dismissProfileSetup` (not `completeProfileSetup`):
   * the just-claimed profile is being thrown away, not adopted, so its held
   * tailnet-sidecar reference (if any) should be released right away, with
   * no handover grace. */
  function handleSetupUseExisting(existingId: string): void {
    if (setupSnapshot.state?.status !== "ready") return;
    const newProfile = setupSnapshot.state.profile;

    if (isProfileRevoked(existingId)) {
      addProfile({ ...newProfile, id: existingId });
      clearProfileRevoked(existingId);
    }
    removeProfile(newProfile.id);

    dismissProfileSetup();
    handleProfileChange(existingId);
    openTab(existingId, crypto.randomUUID(), null, true);
  }

  return { handleProfileChange, handleSetupContinue, handleSetupUseExisting };
}
