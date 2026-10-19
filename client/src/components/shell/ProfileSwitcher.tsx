import { useState } from "react";
import { Check, ChevronsUpDown, Plus, Link2, RotateCw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { profileColorClass, type Profile } from "@/lib/profiles/profiles";
import { useProfiles } from "@/hooks/profiles/useProfiles";
import { useRevokedProfiles } from "@/hooks/profiles/useProfileRevoked";
import { useDict } from "@/i18n";
import { profileBadge } from "@/lib/profiles/profileBadge";
import { resumeProfileSetup } from "@/lib/profiles/profileSetup";
import { AddProfileDialog } from "@/components/shell/AddProfileDialog";
import { McpSignInDialog, type McpSignInTarget } from "@/components/shell/McpSignInDialog";
import { AddRemoteMachineDialog } from "@/components/shell/AddRemoteMachineDialog";

/** The profile's colour as a small square — the same mark the session rows
 * and the dropdown use, so the colour means one thing everywhere. */
function ProfileSquare({ profileId, size = "sm" }: { profileId: string; size?: "sm" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center border border-border bg-surface-hover",
        size === "lg" ? "size-[22px]" : "size-3.5",
      )}
    >
      <span className={cn(size === "lg" ? "size-2" : "size-1.5", profileColorClass(profileId))} />
    </span>
  );
}

interface ProfileSwitcherProps {
  activeProfile: Profile;
  /** Passed in rather than resolved here: the sync that answers it has to
   * keep running with this component unmounted (see `App`). */
  supported: boolean;
  onChange: (profileId: string) => void;
  /** Whether the session list spans every profile (as opposed to only the
   * active one) — the one view setting that lives in this menu. */
  allProfilesShown: boolean;
  onToggleAllProfiles: () => void;
}

export function ProfileSwitcher({ activeProfile, supported, onChange, allProfilesShown, onToggleAllProfiles }: ProfileSwitcherProps) {
  const profiles = useProfiles();
  const dict = useDict();
  const revoked = useRevokedProfiles();
  const [addOpen, setAddOpen] = useState(false);
  // Set by AddProfileDialog when a copied setup brought MCP servers along
  // — kept here rather than inside that dialog so the sign-in outlives it.
  const [mcpSignIn, setMcpSignIn] = useState<McpSignInTarget | null>(null);
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
            className="group flex h-10 w-full cursor-pointer items-center gap-2.5 px-2 text-left transition-colors hover:bg-bg-hover"
          >
            <ProfileSquare profileId={activeProfile.id} size="lg" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[length:calc(13.5px*var(--chrome-scale))] leading-tight font-medium text-foreground">
                {activeProfile.label}
              </span>
              <span className="truncate font-mono text-[length:calc(11px*var(--chrome-scale))] leading-tight text-text-faint">
                {activeBadge.label} · {allProfilesShown ? dict.shell.profiles.scopeAll : dict.shell.profiles.scopeActive}
              </span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-text-faint transition-colors group-hover:text-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
          <DropdownMenuLabel>{dict.shell.profiles.heading}</DropdownMenuLabel>
          {profiles.map((profile) => {
            const badge = profileBadge(profile, revoked, dict);
            const active = profile.id === activeProfile.id;
            return (
              <DropdownMenuItem
                key={profile.id}
                onSelect={() => onChange(profile.id)}
                className="gap-2.5"
              >
                <ProfileSquare profileId={profile.id} />
                <span className="min-w-0 flex-1 truncate">{profile.label}</span>
                <span className="font-mono text-[11px] text-text-faint">{badge.label}</span>
                <Check className={cn("size-3.5 shrink-0", active ? "text-foreground" : "invisible")} />
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={allProfilesShown} onCheckedChange={onToggleAllProfiles}>
            {dict.shell.profiles.allProfilesToggle}
          </DropdownMenuCheckboxItem>
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
        <AddProfileDialog open={addOpen} onOpenChange={setAddOpen} activeProfile={activeProfile} onMcpSignInNeeded={setMcpSignIn} />
      )}

      <McpSignInDialog open={mcpSignIn !== null} onOpenChange={(next) => !next && setMcpSignIn(null)} target={mcpSignIn} />
    </>
  );
}
