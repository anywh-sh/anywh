import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useMergedSessions } from "@/hooks/tabs/useMergedSessions";
import { useProfiles } from "@/hooks/profiles/useProfiles";
import { useDict, useLocale } from "@/i18n";
import { formatRelativeTime } from "@/lib/format/relativeTime";
import {
  buildSearchIndex,
  MAX_INDEXED_TITLE_CHARS,
  searchSessions,
  type MatchRange,
  type SearchGroup,
  type SearchResult,
} from "@/lib/format/sessionSearch";
import { profileColorClass } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SearchIcon, XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

interface SessionSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSession: (profileId: string, sessionId: string, title: string) => void;
}

const GROUP_ROW_HEIGHT = 32;
const SESSION_ROW_HEIGHT = 36;
const LIST_MAX_HEIGHT = 372;

type Row = { kind: "group"; profileId: string; label: string } | { kind: "session"; result: SearchResult; sessionIndex: number };

/** The groups flattened into the one list the virtualizer walks: a header row
 * per profile followed by its sessions. `sessionIndex` counts only the
 * sessions — it is what arrow keys and `aria-activedescendant` move over. */
function flattenGroups(groups: SearchGroup[], labels: ReadonlyMap<string, string>): Row[] {
  const rows: Row[] = [];
  let sessionIndex = 0;
  for (const group of groups) {
    rows.push({ kind: "group", profileId: group.profileId, label: labels.get(group.profileId) ?? group.profileId });
    for (const result of group.results) rows.push({ kind: "session", result, sessionIndex: sessionIndex++ });
  }
  return rows;
}

/**
 * Search across every profile, over the cached session list the sidebar
 * already renders — it reaches no relay, so opening it or typing never wakes
 * anything. The palette lives in its own component so that closing it throws
 * the query and the highlighted row away.
 */
export function SessionSearch({ open, onOpenChange, onSelectSession }: SessionSearchProps) {
  const dict = useDict();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-black/55" />
        <DialogPrimitive.Content
          data-slot="session-search"
          aria-describedby={undefined}
          className="fixed top-[72px] left-1/2 z-50 w-[540px] max-w-[calc(100%-2rem)] -translate-x-1/2 border border-border bg-bg-sidebar shadow-popover outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{dict.shell.search.title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{dict.shell.search.description}</DialogPrimitive.Description>
          <SearchPalette onClose={() => onOpenChange(false)} onSelectSession={onSelectSession} />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function SearchPalette({ onClose, onSelectSession }: { onClose: () => void; onSelectSession: SessionSearchProps["onSelectSession"] }) {
  const dict = useDict().shell.search;
  const { locale } = useLocale();
  const profiles = useProfiles();
  const listId = useId();
  const allProfileIds = useMemo(() => new Set(profiles.map((profile) => profile.id)), [profiles]);
  // Unfiltered on purpose: the sidebar's profile filter is about what the
  // list shows, and someone reaching for search is looking for a session
  // they cannot see.
  const sessions = useMergedSessions(allProfileIds);
  const labels = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile.label])), [profiles]);
  const index = useMemo(() => buildSearchIndex(sessions), [sessions]);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [active, setActive] = useState(0);
  const groups = useMemo(() => searchSessions(index, deferredQuery), [index, deferredQuery]);
  const rows = useMemo(() => flattenGroups(groups, labels), [groups, labels]);
  const sessionRows = useMemo(() => rows.flatMap((row, rowIndex) => (row.kind === "session" ? [{ row, rowIndex }] : [])), [rows]);
  const count = sessionRows.length;
  const hasQuery = deferredQuery.trim() !== "";

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (rowIndex) => (rows[rowIndex].kind === "group" ? GROUP_ROW_HEIGHT : SESSION_ROW_HEIGHT),
    overscan: 6,
    initialRect: { width: 540, height: LIST_MAX_HEIGHT },
  });

  const activeRowIndex = sessionRows[active]?.rowIndex;
  useEffect(() => {
    if (activeRowIndex === undefined) return;
    // A group header sits right above its first session: reveal it too, so
    // arrowing up to the top shows the heading rather than hiding it.
    const target = rows[activeRowIndex - 1]?.kind === "group" ? activeRowIndex - 1 : activeRowIndex;
    virtualizer.scrollToIndex(target);
    if (target !== activeRowIndex) virtualizer.scrollToIndex(activeRowIndex);
  }, [activeRowIndex, rows, virtualizer]);

  const choose = (result: SearchResult) => {
    onSelectSession(result.session.profileId, result.session.id, result.session.title);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (count > 0) setActive((current) => (current + 1) % count);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (count > 0) setActive((current) => (current - 1 + count) % count);
        break;
      case "Enter": {
        event.preventDefault();
        const picked = sessionRows[active]?.row;
        if (picked?.kind === "session") choose(picked.result);
        break;
      }
      case "Escape":
        // Esc backs out of a query first and only then out of the palette.
        if (query !== "") {
          event.preventDefault();
          event.stopPropagation();
          setQuery("");
          setActive(0);
        }
        break;
    }
  };

  const activeId = activeRowIndex === undefined ? undefined : `${listId}-${active}`;
  const totalLabel = hasQuery
    ? count === 1
      ? dict.resultsOne
      : dict.resultsMany.replace("{count}", String(count))
    : sessions.length === 1
      ? dict.totalOne
      : dict.totalMany.replace("{count}", String(sessions.length));

  return (
    <>
      <div className="flex h-[50px] items-center gap-3 border-b border-border-soft pr-3 pl-4">
        <SearchIcon className="size-4 shrink-0 text-text-faint" aria-hidden />
        <input
          role="combobox"
          aria-label={dict.placeholder}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          placeholder={dict.placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-[length:calc(15px*var(--chrome-scale))] text-foreground outline-none placeholder:text-text-faint"
        />
        {query !== "" ? (
          <button
            type="button"
            aria-label={dict.clear}
            onClick={() => {
              setQuery("");
              setActive(0);
            }}
            className="flex size-6 items-center justify-center text-text-faint transition-colors hover:text-muted-foreground"
          >
            <XIcon className="size-3" aria-hidden />
          </button>
        ) : null}
      </div>
      <div ref={scrollRef} className="overflow-y-auto p-1.5" style={{ maxHeight: LIST_MAX_HEIGHT }}>
        <div id={listId} role="listbox" aria-label={dict.listLabel} className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const style = { height: item.size, transform: `translateY(${item.start}px)` };
            if (row.kind === "group") {
              return (
                <div
                  key={`g:${row.profileId}`}
                  aria-hidden
                  style={style}
                  className="absolute top-0 left-0 flex w-full items-center gap-2 px-2.5 font-mono text-[length:calc(11.5px*var(--chrome-scale))] font-medium text-text-faint"
                >
                  <span className={cn("size-1.5 shrink-0", profileColorClass(row.profileId))} />
                  <span className="min-w-0 truncate">{row.label}</span>
                </div>
              );
            }
            const { result, sessionIndex } = row;
            const selected = sessionIndex === active;
            return (
              <div
                key={`s:${result.session.profileId}:${result.session.id}`}
                id={`${listId}-${sessionIndex}`}
                role="option"
                aria-selected={selected}
                style={style}
                onClick={() => choose(result)}
                onMouseMove={() => {
                  if (!selected) setActive(sessionIndex);
                }}
                className={cn(
                  "absolute top-0 left-0 flex w-full cursor-default items-center gap-2.5 px-2.5 text-left text-[length:calc(13.5px*var(--chrome-scale))] transition-colors",
                  selected && "bg-bg-hover",
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  <HighlightedTitle title={result.session.title} ranges={result.ranges} dimmed={hasQuery} />
                </span>
                {result.session.lastActiveAt !== null ? (
                  <span className="shrink-0 font-mono text-[length:calc(11px*var(--chrome-scale))] text-text-faint">
                    {formatRelativeTime(result.session.lastActiveAt, locale)}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        {count === 0 && hasQuery ? (
          <div className="flex flex-col items-center gap-1.5 px-4 pt-7 pb-[30px] text-center">
            <span className="text-[length:calc(13.5px*var(--chrome-scale))] text-muted-foreground">
              {dict.emptyTitle.replace("{query}", deferredQuery.trim())}
            </span>
            <span className="text-[length:calc(12.5px*var(--chrome-scale))] text-text-faint">{dict.emptyHint}</span>
          </div>
        ) : null}
      </div>
      <div className="flex h-9 items-center gap-3.5 border-t border-border-soft px-4 font-mono text-[length:calc(11px*var(--chrome-scale))] text-text-faint">
        <span>{totalLabel}</span>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex gap-[3px]">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </span>
          {dict.navigate}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          {dict.open}
        </span>
      </div>
    </>
  );
}

/** The title with the matched stretches in the strong ink and the rest
 * dimmed; with no query there is nothing to contrast, so it is one run. Only
 * the first characters are drawn — the row is one truncated line, and a
 * stored title can be enormous. */
function HighlightedTitle({ title, ranges, dimmed }: { title: string; ranges: MatchRange[]; dimmed: boolean }) {
  const shown = title.slice(0, MAX_INDEXED_TITLE_CHARS);
  if (!dimmed || ranges.length === 0) return <span className="text-muted-foreground">{shown}</span>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(<span key={`r${cursor}`} className="text-text-faint">{shown.slice(cursor, start)}</span>);
    parts.push(<span key={`m${start}`} className="font-medium text-foreground">{shown.slice(start, end)}</span>);
    cursor = end;
  }
  if (cursor < shown.length) parts.push(<span key={`r${cursor}`} className="text-text-faint">{shown.slice(cursor)}</span>);
  return <>{parts}</>;
}
