import { memo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { AnywhLockup } from "@/components/shell/AnywhLogo";
import { SessionList } from "@/components/shell/SessionList";
import { ProfileFilterTrigger, ProfileFilterPanel } from "@/components/shell/ProfileFilter";
import { RenameSessionDialog } from "@/components/shell/RenameSessionDialog";
import { ProfileSwitcher } from "@/components/shell/ProfileSwitcher";
import { useDict } from "@/i18n";
import type { Profile } from "@/lib/profiles/profiles";
import type { MergedSession } from "@/lib/format/sessionGrouping";
import { shortcutLabel } from "@/lib/platform/platform";

export interface SidebarProps {
  activeProfile: Profile;
  profiles: Profile[];
  /** Whether the host answers the control API — resolved by the profile
   * sync in `App`, which owns it because this component can unmount. */
  profilesSupported: boolean;
  onProfileChange: (profileId: string) => void;
  /** Which profiles the list shows. Separate from `activeProfile`, which is
   * about where work happens, not about what is on screen. */
  selectedProfileIds: ReadonlySet<string>;
  onToggleProfileFilter: (profileId: string) => void;
  onClearProfileFilter: () => void;
  sessions: MergedSession[];
  sessionsLoading: boolean;
  sessionsError: boolean;
  onRetrySessions: () => void;
  selectedSession: string | null;
  runningSessions: Set<string>;
  backgroundJobSessions: Set<string>;
  onSelectSession: (session: MergedSession) => void;
  onNewConversation: () => void;
  onRenameSession: (session: MergedSession, title: string) => void;
  onDeleteSession: (session: MergedSession) => void;
}

/**
 * Memoized: this renders one row per session across every selected profile
 * — a few hundred rows on a real install — and it is mounted for the whole
 * life of the desktop shell, so every state change in `App` used to walk the
 * entire list. Switching tabs did it two to three times in a row.
 *
 * Every prop it takes is either state (`selectedProfileIds`, the loading
 * flags), a value with a stable identity between real changes (`profiles`
 * and `activeProfile` come from the profiles store, `sessions` from
 * `useMergedSessions`' memo, the two `Set`s from a memo on the tab list) or
 * a callback `App` holds stable on purpose. Handing it anything rebuilt per
 * render silently undoes all of this.
 */
export const Sidebar = memo(function Sidebar({
  activeProfile,
  profiles,
  profilesSupported,
  onProfileChange,
  selectedProfileIds,
  onToggleProfileFilter,
  onClearProfileFilter,
  sessions,
  sessionsLoading,
  sessionsError,
  onRetrySessions,
  selectedSession,
  runningSessions,
  backgroundJobSessions,
  onSelectSession,
  onNewConversation,
  onRenameSession,
  onDeleteSession,
}: SidebarProps) {
  const dict = useDict();
  const [renaming, setRenaming] = useState<{ session: MergedSession; title: string } | null>(null);
  const [profileFilterOpen, setProfileFilterOpen] = useState(false);
  const profileFiltering = selectedProfileIds.size < profiles.length;

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg-sidebar">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-2.5">
        <AnywhLockup className="flex min-w-0 flex-1 items-center gap-2" />
        <ProfileFilterTrigger
          filtering={profileFiltering}
          selectedCount={selectedProfileIds.size}
          open={profileFilterOpen}
          onToggle={() => setProfileFilterOpen((value) => !value)}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" onClick={onNewConversation} aria-label={dict.shell.sidebar.newConversation}>
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {dict.shell.sidebar.newConversation}
            <TooltipShortcut>{shortcutLabel("N")}</TooltipShortcut>
          </TooltipContent>
        </Tooltip>
      </div>

      {profileFilterOpen && (
        <ProfileFilterPanel
          profiles={profiles}
          selected={selectedProfileIds}
          onToggle={onToggleProfileFilter}
          onSelectAll={onClearProfileFilter}
        />
      )}

      <SessionList
        sessions={sessions}
        profiles={profiles}
        selectedProfileCount={selectedProfileIds.size}
        loading={sessionsLoading}
        error={sessionsError}
        onRetry={onRetrySessions}
        selected={selectedSession}
        running={runningSessions}
        backgroundJobSessions={backgroundJobSessions}
        onSelect={onSelectSession}
        onRename={(session) => setRenaming({ session, title: session.title })}
        onDelete={onDeleteSession}
        onClearFilter={onClearProfileFilter}
      />

      <div className="shrink-0 border-t border-border-soft p-2.5">
        <ProfileSwitcher activeProfile={activeProfile} supported={profilesSupported} onChange={onProfileChange} />
      </div>

      <RenameSessionDialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        initialTitle={renaming?.title ?? ""}
        onSave={(title) => {
          if (renaming) onRenameSession(renaming.session, title);
          setRenaming(null);
        }}
      />
    </div>
  );
});
