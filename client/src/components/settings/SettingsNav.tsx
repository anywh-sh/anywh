import { useState } from "react";
import { Link2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AddProfileDialog } from "@/components/shell/AddProfileDialog";
import { AddRemoteMachineDialog } from "@/components/shell/AddRemoteMachineDialog";
import { useRevokedProfiles } from "@/hooks/useProfileRevoked";
import { useDict } from "@/i18n";
import { profileBadge } from "@/lib/profileBadge";
import { profileColorClass, type Profile } from "@/lib/profiles";
import { cn } from "@/lib/utils";

/** Which page the dialog is showing: one of the two app-wide pages, or one
 * profile. A profile is addressed by id rather than by index so removing
 * one doesn't silently select its neighbour. */
export type SettingsSection = { kind: "appearance" } | { kind: "updates" } | { kind: "profile"; profileId: string };

function NavEyebrow({ children, count }: { children: string; count?: number }) {
  return (
    <div className="flex items-baseline gap-1.5 px-2.5 pt-4 pb-1.5 font-mono text-[9.5px] tracking-[0.13em] text-text-faint uppercase first:pt-1">
      <span className="flex-1">{children}</span>
      {count !== undefined && <span className="tracking-normal opacity-80">{count}</span>}
    </div>
  );
}

function NavButton({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 border px-2.5 py-1.5 text-left font-mono text-xs transition-colors",
        active
          ? "border-border bg-surface-hover text-foreground"
          : "border-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * The dialog's left rail: the app itself on top, then every profile this
 * device knows, then the way to add another one. It replaces the profile
 * dropdown that used to sit above the settings — with a page per profile
 * there is nothing left to scope, and the list doubles as the answer to
 * "which profiles do I even have here".
 */
export function SettingsNav({
  profiles,
  activeProfile,
  section,
  onSelect,
  supported,
}: {
  profiles: Profile[];
  /** Marked with its own colour down the left edge, the same language the
   * session list, the tab strip and the profile switcher already use. */
  activeProfile: Profile;
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  /** Whether the connected host runs the control API — creating a profile
   * on it is only offered when it does (see `ProfileSwitcher`). */
  supported: boolean;
}) {
  const dict = useDict();
  const revoked = useRevokedProfiles();
  const [addOpen, setAddOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);

  return (
    <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-bg-chrome p-2">
      <NavEyebrow>{dict.settings.nav.app}</NavEyebrow>
      <NavButton active={section.kind === "appearance"} onClick={() => onSelect({ kind: "appearance" })}>
        <span className="min-w-0 flex-1 truncate">{dict.settings.nav.appearance}</span>
      </NavButton>
      <NavButton active={section.kind === "updates"} onClick={() => onSelect({ kind: "updates" })}>
        <span className="min-w-0 flex-1 truncate">{dict.settings.nav.updates}</span>
      </NavButton>

      <NavEyebrow count={profiles.length}>{dict.settings.nav.profiles}</NavEyebrow>
      {profiles.map((profile) => {
        const badge = profileBadge(profile, revoked, dict);
        return (
          <NavButton
            key={profile.id}
            active={section.kind === "profile" && section.profileId === profile.id}
            onClick={() => onSelect({ kind: "profile", profileId: profile.id })}
            className={cn(profile.id === activeProfile.id && "shadow-[inset_2px_0_0_currentColor]")}
          >
            <span className={cn("inline-block size-2.5 shrink-0", profileColorClass(profile.id))} />
            <span className="min-w-0 flex-1 truncate">{profile.label}</span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </NavButton>
        );
      })}

      {/* Dashed, like the design's — the one control here that creates
          something rather than navigating to it. Two ways in, because the
          app has two: pairing a machine is how a device with nothing
          reachable gets its first profile, while creating one needs a host
          already answering. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="mt-1.5 flex w-full cursor-pointer items-center gap-2 border border-dashed border-border px-2.5 py-1.5 font-mono text-xs text-text-faint transition-colors hover:border-text-faint hover:bg-surface-hover hover:text-foreground"
          >
            <Plus className="size-3" />
            {dict.shell.profiles.addProfile}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
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
      {supported && <AddProfileDialog open={addOpen} onOpenChange={setAddOpen} activeProfile={activeProfile} />}
    </nav>
  );
}
