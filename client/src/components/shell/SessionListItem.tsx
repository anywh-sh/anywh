import { memo } from "react";
import { SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDict, useLocale } from "@/i18n";
import { profileColorClass, profileColorVar } from "@/lib/profiles/profiles";
import { formatRelativeTime } from "@/lib/format/relativeTime";
import type { MergedSession } from "@/lib/format/sessionGrouping";
import { useContextMenu } from "@/hooks/platform/useContextMenu";
import { SessionDeleteMenu } from "@/components/shell/SessionDeleteMenu";

interface SessionListItemProps {
  session: MergedSession;
  /** The profile's label, resolved by the list — the row only carries an id,
   * and looking the label up per row would walk the profiles array once for
   * every session on screen. */
  profileLabel: string;
  /** Whether the profile name is worth the second line at all: with a single
   * profile in view it is the same word on every row. The colour bar stays
   * either way, since it also reads as the selection indicator. */
  showProfile: boolean;
  selected: boolean;
  running: boolean;
  /** `anywh-bg` job currently observed on this session
   * — same limitation as `running`: only sessions open as a tab have this
   * information (no tab = no live WS connection to know it). */
  hasBackgroundJob: boolean;
  onSelect: (session: MergedSession) => void;
  onRename: (session: MergedSession) => void;
  onDelete: (session: MergedSession) => void;
  size?: "default" | "lg";
}

/**
 * Memoized per row. The list above re-renders for things that concern one
 * row at most — a turn starting somewhere, a title arriving, the selection
 * moving — and without this each of those walks every session on screen,
 * each row carrying a context menu and a relative-time format.
 */
export const SessionListItem = memo(function SessionListItem({
  session,
  profileLabel,
  showProfile,
  selected,
  running,
  hasBackgroundJob,
  onSelect,
  onRename,
  onDelete,
  size = "default",
}: SessionListItemProps) {
  const dict = useDict();
  const { locale } = useLocale();
  const menu = useContextMenu();
  const indicatorLabel = running ? dict.shell.sidebar.agentWorking : dict.shell.sidebar.backgroundJob;
  // A relay too old to report when the session was last used leaves the row
  // without a time rather than with a made-up one — the meta line then only
  // exists if the profile name is on it.
  const lastActive = session.lastActiveAt === null ? null : formatRelativeTime(session.lastActiveAt, locale);

  return (
    <div className="relative flex items-center" onContextMenu={menu.onContextMenu}>
      {/* The profile's colour as a bar down the left edge, not a dot: it is
       * the one piece of per-row chrome that has to survive a long title
       * truncating, and it doubles as the selected-row marker. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-0.5 shrink-0",
          profileColorClass(session.profileId),
          !selected && "opacity-55",
        )}
      />
      <button
        type="button"
        onClick={() => onSelect(session)}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-0.5 border border-transparent px-3 text-left transition-colors",
          size === "lg" ? "py-2.5" : "py-2",
          selected ? "border-border bg-bg-elevated" : "hover:bg-surface-hover",
        )}
      >
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              size === "lg" ? "text-base" : "text-[length:calc(13px*var(--font-scale-ratio))]",
              selected ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {session.title}
          </span>
          {/* One animated indicator per row at most, `running` first — a
           * live turn and a background job on the same session would
           * otherwise stack two. The ring (the design's live-session marker,
           * tinted in the session's own profile color) is reserved for an
           * actual turn in flight; the design never modeled a background
           * job at all, so that case gets its own glyph instead of being
           * forced into the same language — a pulsing terminal icon, since
           * that is literally what `anywh-bg` runs. */}
          {running ? (
            <span
              aria-label={indicatorLabel}
              className="size-3 shrink-0 animate-spin rounded-full border-2 border-border"
              style={{ borderTopColor: profileColorVar(session.profileId) }}
            />
          ) : (
            hasBackgroundJob && (
              <SquareTerminal aria-label={indicatorLabel} className="size-3 shrink-0 animate-pulse text-muted-foreground" />
            )
          )}
        </span>
        {(showProfile || lastActive !== null) && (
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[length:calc(10.5px*var(--font-scale-ratio))] text-text-faint">
            {showProfile && <span className="max-w-22 shrink-0 truncate">{profileLabel}</span>}
            {showProfile && lastActive !== null && <span aria-hidden="true">·</span>}
            {lastActive !== null && <span className="truncate">{lastActive}</span>}
          </span>
        )}
      </button>
      <SessionDeleteMenu menu={menu} title={session.title} onRename={() => onRename(session)} onDelete={() => onDelete(session)} />
    </div>
  );
});
