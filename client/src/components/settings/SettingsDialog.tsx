import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import { ProfileSettings } from "@/components/settings/ProfileSettings";
import { SettingsNav, type SettingsSection } from "@/components/settings/SettingsNav";
import { useProfiles } from "@/hooks/useProfiles";
import { useDict } from "@/i18n";
import type { Profile } from "@/lib/profiles";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeProfile: Profile;
  /** Whether the connected host runs the control API. Passed in rather than
   * resolved here: the sync that answers it has to keep running with this
   * dialog closed (same reason `ProfileSwitcher` takes it as a prop). */
  profilesSupported: boolean;
}

/**
 * App settings — opened from the `TitleBar` menu. Two panes: a rail listing
 * the app itself and every profile on this device, and the page for
 * whichever of them is selected.
 *
 * A page per profile, rather than one set of fields with a profile picker
 * on top: the fields were never app-wide to begin with, and a list of
 * profiles you can click through makes that obvious instead of hiding it
 * behind a dropdown someone has to notice. Opening always lands on the
 * profile the app is actually connected to.
 */
export function SettingsDialog({ open, onOpenChange, activeProfile, profilesSupported }: SettingsDialogProps) {
  const dict = useDict();
  const profiles = useProfiles();
  const [section, setSection] = useState<SettingsSection>({ kind: "profile", profileId: activeProfile.id });

  useEffect(() => {
    if (open) setSection({ kind: "profile", profileId: activeProfile.id });
  }, [open, activeProfile.id]);

  const selectedIndex =
    section.kind === "profile" ? profiles.findIndex((profile) => profile.id === section.profileId) : -1;
  const selectedProfile = selectedIndex >= 0 ? profiles[selectedIndex] : undefined;
  // `profile.colorIndex` may be absent on a profile created before the
  // field existed — fall back to its position, which is what
  // `profileColorClass` paints everywhere else.
  const effectiveColorIndex = selectedProfile?.colorIndex ?? Math.max(selectedIndex, 0);

  function handleProfileRemoved(removedId: string): void {
    setSection((current) => {
      if (current.kind !== "profile" || current.profileId !== removedId) return current;
      const fallback = profiles.find((profile) => profile.id !== removedId);
      return fallback ? { kind: "profile", profileId: fallback.id } : { kind: "appearance" };
    });
  }

  // `selectedProfile` wins regardless of `section.kind` on purpose: it's
  // only ever set when `section.kind === "profile"` names one that still
  // exists, and a profile removed from another device has to fall
  // somewhere — back to "appearance", never to a blank pane.
  function renderSection() {
    if (selectedProfile) {
      return (
        <ProfileSettings
          profile={selectedProfile}
          allProfiles={profiles}
          effectiveColorIndex={effectiveColorIndex}
          onProfileRemoved={handleProfileRemoved}
        />
      );
    }
    switch (section.kind) {
      case "appearance":
      case "profile":
        return <AppearanceSettings activeProfile={activeProfile} />;
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(39rem,100%)] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{dict.settings.title}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <SettingsNav
            profiles={profiles}
            activeProfile={activeProfile}
            section={section}
            onSelect={setSection}
            supported={profilesSupported}
          />

          <div className="min-w-0 flex-1 overflow-y-auto px-6 pb-8">{renderSection()}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
