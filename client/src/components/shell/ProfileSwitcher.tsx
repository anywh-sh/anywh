import { useState } from "react";
import { ChevronsUpDown, Plus, Link2, RotateCw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { profileColorClass, type Profile } from "@/lib/profiles";
import { useProfiles } from "@/hooks/useProfiles";
import { useRevokedProfiles } from "@/hooks/useProfileRevoked";
import { useDict } from "@/i18n";
import { profileBadge } from "@/lib/profileBadge";
import { resumeProfileSetup } from "@/lib/profileSetup";
import { AddProfileDialog } from "@/components/shell/AddProfileDialog";
import { AddRemoteMachineDialog } from "@/components/shell/AddRemoteMachineDialog";

interface ProfileSwitcherProps {
  activeProfile: Profile;
  /** Passed in rather than resolved here: the sync that answers it has to
   * keep running with this component unmounted (see `App`). */
  supported: boolean;
  onChange: (profileId: string) => void;
}

export function ProfileSwitcher({ activeProfile, supported, onChange }: ProfileSwitcherProps) {
  const profiles = useProfiles();
  const dict = useDict();
  const revoked = useRevokedProfiles();
  const [addOpen, setAddOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const activeBadge = profileBadge(activeProfile, revoked, dict);

  return (
    <>
      {/* modal={false}: Radix traps focus + pointer-events on the body while
          a modal menu is open, and WKWebView (Tauri on macOS/iOS) fails to
          restore that when this item opens AddProfileDialog on top of it —
          same fix as WorkingDirectoryButton/ModelButton. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={dict.shell.profiles.activeProfile}
            className="flex w-full cursor-pointer items-center gap-2.5 border border-border bg-bg-chrome px-2.5 py-2 text-left transition-colors hover:border-text-faint"
          >
            <span className={cn("inline-block size-2.5 shrink-0", profileColorClass(activeProfile.id))} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{activeProfile.label}</span>
            <Badge variant={activeBadge.variant}>{activeBadge.label}</Badge>
            <ChevronsUpDown className="size-3.5 shrink-0 text-text-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
          <DropdownMenuLabel className="font-mono text-[length:calc(9.5px*var(--font-scale-ratio))] tracking-[0.12em] text-text-faint uppercase">
            {dict.shell.profiles.heading}
          </DropdownMenuLabel>
          {profiles.map((profile) => {
            const badge = profileBadge(profile, revoked, dict);
            const active = profile.id === activeProfile.id;
            return (
              <DropdownMenuItem
                key={profile.id}
                onSelect={() => onChange(profile.id)}
                // The active row is marked by its own profile colour down the
                // left edge rather than by a checkmark — the same language
                // the session list and the tab strip already use, so the
                // colour means one thing everywhere.
                className={cn("gap-2.5", active && "bg-surface-hover text-foreground shadow-[inset_2px_0_0_currentColor]")}
              >
                <span className={cn("inline-block size-2.5 shrink-0", profileColorClass(profile.id))} />
                <span className="min-w-0 flex-1 truncate">{profile.label}</span>
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          {/* One per profile that was saved but never reached (the app
              closed mid-setup, or the verification failed and was left for
              later): re-enters the setup pipeline at "connect" — never at
              the claim, whose code is already spent — and the same
              `ProfileSetupDialog` the shell mounts shows the outcome. */}
          {profiles
            .filter((profile) => profile.unverified)
            .map((profile) => (
              <DropdownMenuItem key={`finish-${profile.id}`} onSelect={() => resumeProfileSetup(profile)}>
                <RotateCw className="size-3.5" />
                {dict.shell.profiles.finishSetup.replace("{label}", profile.label)}
              </DropdownMenuItem>
            ))}
          {/* Ungated on `supported`, unlike "add profile" below: that one
              asks the active host to create an account and needs a working
              connection to it, while this one is how you get a connection in
              the first place — a fresh install with nothing reachable is
              exactly when it's needed most. */}
          <DropdownMenuItem onSelect={() => setPairOpen(true)}>
            <Link2 className="size-3.5" />
            {dict.shell.profiles.addRemoteMachine}
          </DropdownMenuItem>
          {supported && (
            <DropdownMenuItem onSelect={() => setAddOpen(true)}>
              <Plus className="size-3.5" />
              {dict.shell.profiles.addProfile}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AddRemoteMachineDialog open={pairOpen} onOpenChange={setPairOpen} />

      {supported && (
        <AddProfileDialog open={addOpen} onOpenChange={setAddOpen} activeProfile={activeProfile} />
      )}
    </>
  );
}
