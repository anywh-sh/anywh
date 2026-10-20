import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronDown, MessageSquareDashed } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SessionListItem } from "@/components/shell/SessionListItem";
import { SessionListSkeleton } from "@/components/shell/SessionListSkeleton";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/profiles/profiles";
import { recentSessions, type MergedSession } from "@/lib/format/sessionGrouping";
import { groupByState } from "@/lib/format/sessionStateGroups";
import { useRoomStatuses } from "@/lib/sala/roomStatus";

/** The sidebar groups: what waits for the person, what runs, then the rest. */
type HeadingId = "needsYou" | "running" | "recent";

/** The grouped list flattened into one row stream, which is what a
 * virtualizer can index into — headings included, so a heading scrolls with
 * its sessions instead of needing a second, parallel mechanism. */
type Row =
  | { kind: "heading"; id: HeadingId; count: number }
  | { kind: "session"; session: MergedSession };

function rowKey(row: Row): string {
  return row.kind === "heading" ? `heading:${row.id}` : `${row.session.profileId}:${row.session.id}`;
}

// Only a starting point for a row that has not been measured yet: every one
// of them reports its real height through `measureElement` as it mounts (a
// row is one or two lines depending on whether it carries a profile name and
// a timestamp). Wrong estimates cost scrollbar accuracy far from the
// viewport, nothing else.
const ESTIMATED_HEADING_PX = 36;
const ESTIMATED_ROW_PX = { default: 32, lg: 58 } as const;

interface SessionListProps {
  /** Already merged across the selected profiles and sorted newest-first. */
  sessions: MergedSession[];
  profiles: Profile[];
  /** How many profiles the filter currently shows — drives whether a row
   * needs to name its profile, and tells the empty state whether the list is
   * empty because there is nothing or because the filter hid it. */
  selectedProfileCount: number;
  loading: boolean;
  /** Set once the active profile's fetch (`useSessionNames`) fails — cleared
   * by a successful `reload()` or a profile switch, never by itself. */
  error: boolean;
  onRetry: () => void;
  selected: string | null;
  running: Set<string>;
  backgroundJobSessions: Set<string>;
  onSelect: (session: MergedSession) => void;
  onRename: (session: MergedSession) => void;
  onDelete: (session: MergedSession) => void;
  onClearFilter: () => void;
  /** "lg" used only by the iOS drawer — larger text to match the rest of
   * that sheet. */
  size?: "default" | "lg";
}

export function SessionList({
  sessions,
  profiles,
  selectedProfileCount,
  loading,
  error,
  onRetry,
  selected,
  running,
  backgroundJobSessions,
  onSelect,
  onRename,
  onDelete,
  onClearFilter,
  size = "default",
}: SessionListProps) {
  const dict = useDict();
  const roomStatuses = useRoomStatuses();
  const groups = useMemo(() => {
    const { needsYou, running: runningNow, rest } = groupByState(sessions, running, roomStatuses);
    const recent = recentSessions(rest);
    return [
      ...(needsYou.length > 0 ? [{ id: "needsYou" as const, sessions: needsYou }] : []),
      ...(runningNow.length > 0 ? [{ id: "running" as const, sessions: runningNow }] : []),
      ...(recent.length > 0 ? [{ id: "recent" as const, sessions: recent }] : []),
    ];
  }, [sessions, running, roomStatuses]);
  // One pass instead of a lookup per row: the list can hold every session of
  // every profile now, and this renders on each sidebar render.
  // Groups the user folded away: the heading stays (with its count), the
  // rows go. Kept in memory only — a fold is a way to get a long list out of
  // the way for now, not a setting.
  const [collapsed, setCollapsed] = useState<ReadonlySet<HeadingId>>(() => new Set());
  const toggleGroup = useCallback((id: HeadingId) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const rows = useMemo<Row[]>(
    () =>
      groups.flatMap((group) => [
        { kind: "heading", id: group.id, count: group.sessions.length },
        ...(collapsed.has(group.id) ? [] : group.sessions.map((session): Row => ({ kind: "session", session }))),
      ]),
    [groups, collapsed],
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) =>
      rows[index].kind === "heading" ? ESTIMATED_HEADING_PX : ESTIMATED_ROW_PX[size],
    getItemKey: (index) => rowKey(rows[index]),
    overscan: 6,
  });
  // "Nothing here" and "nothing here *because of the filter*" are different
  // answers, and conflating them is how someone concludes their history is
  // gone when they have narrowed the view down to a profile with nothing in
  // it.
  const filtering = selectedProfileCount < profiles.length;

  // Same sizing as the `ScrollArea` below (`min-h-0 flex-1`) — without it,
  // the skeleton's own content height (a handful of fixed-width bars) is
  // all the flex column gives this slot, and whatever sits after `SessionList`
  // in the layout (`ProfileSwitcher`'s footer in Sidebar.tsx) gets pulled up
  // instead of staying pinned to the bottom while sessions load.
  if (loading && sessions.length === 0)
    return (
      <div className="min-h-0 flex-1">
        <SessionListSkeleton size={size} />
      </div>
    );

  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
      <div className={cn("flex flex-col", size === "lg" ? "pb-2" : "px-2 pb-3")}>
        {error && (
          <div className="flex flex-col items-start gap-2 px-2 py-2 text-xs text-muted-foreground">
            <p>{dict.shell.sidebar.loadFailed}</p>
            <Button type="button" variant="outline" size="xs" onClick={onRetry}>
              {dict.common.retry}
            </Button>
          </div>
        )}

        {!error && sessions.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-5 py-9 text-center">
            <span className="flex size-8 items-center justify-center border border-dashed border-border text-text-faint">
              <MessageSquareDashed className="size-4" />
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {filtering ? dict.shell.sidebar.noMatches : dict.shell.sidebar.emptyTitle}
            </span>
            {filtering ? (
              <Button type="button" variant="outline" size="xs" onClick={onClearFilter}>
                {dict.shell.sidebar.allProfiles}
              </Button>
            ) : (
              <span className="max-w-48 text-xs leading-relaxed text-text-faint">{dict.shell.sidebar.emptyBody}</span>
            )}
          </div>
        )}

        {/* Virtualized: the list holds every session of every profile, and
         * it re-renders whenever the selection moves — which is every tab
         * switch. Rendering only what is on screen is what keeps that cost
         * flat instead of proportional to how much history exists. */}
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${String(virtualRow.start)}px)` }}
              >
                {row.kind === "heading" ? (
                  <button
                    type="button"
                    aria-expanded={!collapsed.has(row.id)}
                    onClick={() => toggleGroup(row.id)}
                    className={cn(
                      "flex h-[26px] w-full cursor-pointer items-center gap-2 px-[9px] text-left font-mono text-[length:calc(11.5px*var(--chrome-scale))] font-medium text-text-faint transition-colors hover:text-muted-foreground",
                      // `first:pt-2` can't do this job once rows are
                      // windowed: the first rendered child is whatever
                      // happens to be scrolled into view, not row zero.
                      virtualRow.index > 0 && "mt-2.5",
                    )}
                  >
                    <ChevronDown className={cn("-mr-1 size-2.5 shrink-0 transition-transform", collapsed.has(row.id) && "-rotate-90")} aria-hidden />
                    <span className="opacity-80">{dict.shell.sidebar[row.id]}</span>
                    <span aria-hidden="true" className="min-w-0 flex-1 border-t border-dashed border-border" />
                    <span>{row.count}</span>
                  </button>
                ) : (
                  <SessionListItem
                    session={row.session}
                    selected={selected === row.session.id}
                    running={running.has(row.session.id)}
                    roomStatus={roomStatuses.get(row.session.id)}
                    hasBackgroundJob={backgroundJobSessions.has(row.session.id)}
                    onSelect={onSelect}
                    onRename={onRename}
                    onDelete={onDelete}
                    size={size}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}
