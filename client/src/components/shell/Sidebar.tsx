import { memo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { KbdShortcut } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { SessionList } from "@/components/shell/SessionList";
import { RenameSessionDialog } from "@/components/shell/RenameSessionDialog";
import { ProfileSwitcher } from "@/components/shell/ProfileSwitcher";
import { useDict } from "@/i18n";
import type { Profile } from "@/lib/profiles/profiles";
import type { MergedSession } from "@/lib/format/sessionGrouping";
import { shortcutKeys } from "@/lib/platform/platform";

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
  /** Flips the list between every profile and only the active one. */
  onToggleAllProfiles: () => void;
  onClearProfileFilter: () => void;
  onOpenSearch: () => void;
  /** The focused tab is a conversation that has not started yet — the
   * new-session row is the one it belongs to, so it is drawn selected. */
  newSessionActive: boolean;
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
  onToggleAllProfiles,
  onClearProfileFilter,
  onOpenSearch,
  newSessionActive,
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
  const allProfilesShown = selectedProfileIds.size >= profiles.length;

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg-sidebar">
      <div className="shrink-0 px-2 pt-0.5">
        <ProfileSwitcher
          activeProfile={activeProfile}
          supported={profilesSupported}
          onChange={onProfileChange}
          allProfilesShown={allProfilesShown}
          onToggleAllProfiles={onToggleAllProfiles}
        />
      </div>

      <div className="flex shrink-0 flex-col gap-1 px-2 pt-2 pb-3">
        <button
          type="button"
          onClick={onOpenSearch}
          aria-label={dict.shell.sidebar.search}
          className="flex h-8 w-full cursor-pointer items-center gap-2.5 border border-border-soft bg-[color-mix(in_srgb,var(--background)_80%,var(--bg-sidebar))] pr-1.5 pl-[9px] text-left text-[length:calc(13px*var(--chrome-scale))] text-text-faint transition-colors hover:text-foreground"
        >
          <Search className="size-3.5 shrink-0" />
          <span className="flex-1">{dict.shell.sidebar.search}</span>
          <KbdShortcut keys={shortcutKeys("K")} />
        </button>
        <button
          type="button"
          onClick={onNewConversation}
          aria-label={dict.shell.sidebar.newConversation}
          className={cn(
            "relative flex h-8 w-full cursor-pointer items-center gap-2.5 pr-1.5 pl-[9px] text-left text-[length:calc(13px*var(--chrome-scale))] transition-colors hover:text-foreground",
            newSessionActive ? "bg-bg-elevated font-medium text-foreground" : "text-muted-foreground hover:bg-bg-hover",
          )}
        >
          {newSessionActive && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-muted-foreground" />}
          <Plus className="size-3.5 shrink-0" />
          <span className="flex-1">{dict.shell.sidebar.newConversation}</span>
          <KbdShortcut keys={shortcutKeys("N")} />
        </button>
      </div>

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
        onOpenSearch={onOpenSearch}
      />

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
