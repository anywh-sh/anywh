import { memo } from "react";
import { Loader2, SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDict, useLocale } from "@/i18n";
import { profileColorClass } from "@/lib/profiles/profiles";
import { formatAbsoluteTime, formatCompactTime } from "@/lib/format/relativeTime";
import type { MergedSession } from "@/lib/format/sessionGrouping";
import { useContextMenu } from "@/hooks/platform/useContextMenu";
import { SessionDeleteMenu } from "@/components/shell/SessionDeleteMenu";
import { TitleSkeleton } from "@/components/ui/title-skeleton";
import { RoomGlyph } from "@/components/sala/SalaIcons";
import type { RoomStatus } from "@/lib/sala/roomStatus";

interface SessionListItemProps {
  session: MergedSession;
  selected: boolean;
  running: boolean;
  /** How a room's agents are doing, for a room row (`undefined` while unknown). */
  roomStatus?: RoomStatus;
  /** `anywh-bg` job currently observed on this session
   * — same limitation as `running`: only sessions open as a tab have this
   * information (no tab = no live WS connection to know it). */
  hasBackgroundJob: boolean;
  /** When it finished, for a row in the Completed group. */
  completedAt?: number;
  /** Recent rows carry no date: the group already says "latest". */
  bare?: boolean;
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
  selected,
  running: turnRunning,
  roomStatus,
  hasBackgroundJob,
  completedAt,
  bare = false,
  onSelect,
  onRename,
  onDelete,
  size = "default",
}: SessionListItemProps) {
  const dict = useDict();
  const { locale } = useLocale();
  const menu = useContextMenu();
  const running = turnRunning || (roomStatus?.working ?? 0) > 0;
  const indicatorLabel = running ? dict.shell.sidebar.agentWorking : dict.shell.sidebar.backgroundJob;
  // A relay too old to report when the session was last used leaves the row
  // without a time rather than with a made-up one — the meta line is then
  // left out. The profile is told apart by the colour bar, not by name.
  const lastActive = session.lastActiveAt === null ? null : formatCompactTime(session.lastActiveAt, locale);

  // Everything in Completed is unseen: it stays "new" until it is opened.
  const freshCompletion = completedAt !== undefined;

  return (
    <div className="relative flex items-center" onContextMenu={menu.onContextMenu}>
      <button
        type="button"
        onClick={() => onSelect(session)}
        className={cn(
          "relative flex w-full cursor-pointer items-center gap-[9px] px-2 text-left transition-colors",
          size === "lg" ? "min-h-11 py-2.5" : "h-[30px]",
          selected ? "bg-bg-elevated" : "hover:bg-bg-hover",
        )}
      >
        {/* The profile's colour as a bar, not a dot: it is the one piece of
         * per-row chrome that has to survive a long title truncating, and it
         * doubles as the selected-row marker — full height when selected, a
         * 14px tick otherwise, animated between. The spacer keeps the title's
         * x the same either way; the bar itself is out of the flow so it can
         * grow past 14px. */}
        <span aria-hidden="true" className="w-0.5 shrink-0" />
        <span
          aria-hidden="true"
          className={cn(
            // Always the row's full height, scaled down to 14px (14/30 of the
            // row) when unselected: a transform composites, where animating
            // `top`/`bottom` would lay out the row on every frame.
            "absolute inset-y-0 left-2 w-0.5 transition-transform",
            profileColorClass(session.profileId),
            selected ? "scale-y-100" : "scale-y-[0.4667]",
          )}
        />
        {session.room === true && <RoomGlyph size={14} className="shrink-0 text-text-faint" aria-label={dict.sala.roomGlyph} role="img" />}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            size === "lg" ? "text-base" : "text-[length:calc(13px*var(--chrome-scale))]",
            selected || freshCompletion ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {session.titlePending === true ? <TitleSkeleton /> : session.title}
        </span>
        {/* Status lives on the right, where the row's meta is: nothing sits
         * between the profile bar and the title, so titles start at the same
         * x whatever the row's state. The glyphs are the tabs' own — orange
         * dot when something waits for the person, spinner while a turn runs,
         * red square after a failure, light dot for a finish not yet seen —
         * so a state reads the same in both places. One indicator at most; a
         * background job gets its own glyph, a pulsing terminal icon, since
         * that is literally what `anywh-bg` runs. */}
        {roomStatus && roomStatus.needsYou > 0 ? (
          <span
            title={dict.shell.sidebar.roomNeedsYou.replace("{count}", String(roomStatus.needsYou))}
            role="img"
            aria-label={dict.shell.sidebar.roomNeedsYou.replace("{count}", String(roomStatus.needsYou))}
            className="size-1.5 shrink-0 rounded-full bg-primary"
          />
        ) : roomStatus && roomStatus.failed > 0 && !running ? (
          <span
            title={dict.shell.sidebar.roomFailed.replace("{count}", String(roomStatus.failed))}
            role="img"
            aria-label={dict.shell.sidebar.roomFailed.replace("{count}", String(roomStatus.failed))}
            className="size-1.5 shrink-0 bg-destructive"
          />
        ) : running ? (
          <Loader2 aria-label={indicatorLabel} className="size-3 shrink-0 animate-spin text-foreground" />
        ) : completedAt !== undefined ? (
          <span
            title={formatAbsoluteTime(completedAt, locale)}
            role="img"
            aria-label={dict.chat.tabs.sessionDone}
            className="size-1.5 shrink-0 rounded-full bg-foreground"
          />
        ) : hasBackgroundJob ? (
          <SquareTerminal aria-label={indicatorLabel} className="size-3 shrink-0 animate-pulse text-muted-foreground" />
        ) : (
          lastActive !== null &&
          !bare && (
            <span
              title={formatAbsoluteTime(session.lastActiveAt ?? 0, locale)}
              className="shrink-0 font-mono text-[length:calc(11px*var(--chrome-scale))] text-text-faint"
            >
              {lastActive}
            </span>
          )
        )}
      </button>
      <SessionDeleteMenu menu={menu} title={session.title} onRename={() => onRename(session)} onDelete={() => onDelete(session)} />
    </div>
  );
});
