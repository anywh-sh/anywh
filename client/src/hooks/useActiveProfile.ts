import { useCallback, useEffect, useState } from "react";
import { findProfile, getProfiles, LAST_PROFILE_STORAGE_KEY, type Profile } from "@/lib/profiles";
import { useProfiles } from "@/hooks/useProfiles";

/** `getProfiles()[0]` is safe here only because `App` never mounts the shell
 * (and so never this hook) with an empty list — the first-run screen owns
 * the window until there is a profile to land on. */
function readInitialProfileId(override: string | null): string {
  if (override && findProfile(override)) return override;
  const saved = localStorage.getItem(LAST_PROFILE_STORAGE_KEY);
  if (saved && findProfile(saved)) return saved;
  return getProfiles()[0].id;
}

export function useActiveProfile(queryOverride: string | null): [Profile, (id: string) => void] {
  const profiles = useProfiles();
  const [profileId, setProfileId] = useState(() => readInitialProfileId(queryOverride));

  const setActiveProfileId = useCallback((id: string) => {
    setProfileId(id);
    localStorage.setItem(LAST_PROFILE_STORAGE_KEY, id);
  }, []);

  // The active profile can disappear without any click here — deleted from
  // another device and picked up by the next profile sync (useProfileSync)
  // — not just from this device's own "Excluir do servidor" button. Persist
  // the fallback instead of leaving it to the `?? profiles[0]` below, which
  // is render-only and never updates `profileId`/localStorage.
  useEffect(() => {
    if (profiles.some((profile) => profile.id === profileId)) return;
    const fallback = profiles[0];
    if (fallback) setActiveProfileId(fallback.id);
  }, [profiles, profileId, setActiveProfileId]);

  return [profiles.find((profile) => profile.id === profileId) ?? profiles[0], setActiveProfileId];
}
