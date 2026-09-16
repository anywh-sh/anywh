import { useMemo, useRef } from "react";
import { MessageSquareDashed } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SessionListItem } from "@/components/shell/SessionListItem";
import { SessionListSkeleton } from "@/components/shell/SessionListSkeleton";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/profiles";
import { groupSessionsByRecency, type MergedSession, type SessionGroupId } from "@/lib/sessionGrouping";

/** The grouped list flattened into one row stream, which is what a
 * virtualizer can index into — headings included, so a heading scrolls with
 * its sessions instead of needing a second, parallel mechanism. */
type Row =
  | { kind: "heading"; id: SessionGroupId; count: number }
  | { kind: "session"; session: MergedSession };

function rowKey(row: Row): string {
  return row.kind === "heading" ? `heading:${row.id}` : `${row.session.profileId}:${row.session.id}`;
}

// Only a starting point for a row that has not been measured yet: every one
// of them reports its real height through `measureElement` as it mounts (a
// row is one or two lines depending on whether it carries a profile name and
// a timestamp). Wrong estimates cost scrollbar accuracy far from the
// viewport, nothing else.
const ESTIMATED_HEADING_PX = 30;
const ESTIMATED_ROW_PX = { default: 46, lg: 58 } as const;

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
  const groups = useMemo(() => groupSessionsByRecency(sessions), [sessions]);
  // One pass instead of a lookup per row: the list can hold every session of
  // every profile now, and this renders on each sidebar render.
  const labels = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile.label])), [profiles]);
  const rows = useMemo<Row[]>(
    () =>
      groups.flatMap((group) => [
        { kind: "heading", id: group.id, count: group.sessions.length },
        ...group.sessions.map((session): Row => ({ kind: "session", session })),
      ]),
    [groups],
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
  const showProfile = selectedProfileCount > 1;
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
                  <div
                    className={cn(
                      "px-1 pt-4 pb-1.5 font-mono text-[length:calc(10px*var(--font-scale-ratio))] tracking-[0.14em] text-text-faint uppercase",
                      // `first:pt-2` can't do this job once rows are
                      // windowed: the first rendered child is whatever
                      // happens to be scrolled into view, not row zero.
                      virtualRow.index === 0 && "pt-2",
                    )}
                  >
                    {dict.shell.sidebar.groups[row.id]}
                    <span className="opacity-75"> {row.count}</span>
                  </div>
                ) : (
                  <SessionListItem
                    session={row.session}
                    profileLabel={labels.get(row.session.profileId) ?? row.session.profileId}
                    showProfile={showProfile}
                    selected={selected === row.session.id}
                    running={running.has(row.session.id)}
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
