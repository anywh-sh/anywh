import { forwardRef, memo, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LogEntryRow } from "@/components/chat/LogEntryRow";
import { UserBubble, AssistantText, TurnFooter } from "@/components/chat/Message";
import { ToolCallCard } from "@/components/chat/ToolCallCard";
import { ActivityGroup } from "@/components/chat/activity/ActivityGroup";
import { ThinkingRow } from "@/components/chat/activity/ThinkingRow";
import { buildTimeline, type TimelineItem } from "@/lib/format/activity";
import { OpenState, OpenStateContext } from "@/lib/format/openState";
import { ErrorMessage } from "@/components/chat/ErrorMessage";
import { cn } from "@/lib/utils";
import { nextScrollToEndVisible } from "@/lib/platform/scrollToEndVisibility";
import { useDict, type Dictionary } from "@/i18n";
import type { LogEntry, AttributionState } from "@/hooks/relay/useMessageLog";

interface MessageLogProps {
  entries: LogEntry[];
  streamingEntries: LogEntry[];
  /** Every tool call's own share of a context-window delta seen so far,
   * keyed by `toolUseId` — see `useMessageLog`'s own doc comment on
   * `AttributionState` for why this is a separate map instead of living on
   * the `tool-result` entry itself. */
  attributionByToolUseId: Record<string, AttributionState>;
  /** Whether there are turns older than what's already loaded —
   * controls whether scrolling near the top still triggers a fetch. */
  hasMoreHistory: boolean;
  /** Older-page request in flight — shows the indicator at the top and also
   * guards against a duplicate request (the same guard already exists in
   * the caller, `ChatPanel`, but checking here too avoids reacting to
   * repeated scroll while the response hasn't arrived yet). */
  loadingOlderHistory: boolean;
  /** Called when the user scrolls near the top of the list, with more
   * history still to fetch. */
  onLoadOlderHistory: () => void;
  /** Extra space at the bottom — on iOS, the composer floats over the log,
   * so the content needs extra breathing room to avoid ending up
   * hidden behind it. */
  className?: string;
  /** Inline style on the scroller — iOS pads the bottom by the native
   * composer's measured height. */
  style?: CSSProperties;
  /** When this changes while the log is pinned to the end, the log re-pins:
   * a taller composer or an opening keyboard would otherwise cover the last lines. */
  endInsetKey?: number;
  /** Fires only when the "jump to end" arrow should appear or disappear (see
   * `nextScrollToEndVisible`) — a few calls per scroll, not one per frame. */
  onScrollToEndVisibleChange?: (visible: boolean) => void;
  /** A finger starts dragging the log. */
  onUserScrollStart?: () => void;
  /** Message editing — `id` of the `kind: "user"` entry that's
   * currently turning into a `<textarea>` (desktop only; on iOS `ChatPanel`
   * never sets this, editing there happens via the composer, not inline).
   * `null` when not editing. */
  editingMessageId: string | null;
  /** Stable identity (comes from refs in `ChatPanel`, not fresh closures on
   * every render) — see the `memo` comment in `Message.tsx`. */
  onStartEdit: (id: string, text: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string, text: string) => void;
  onCopy: (text: string) => void;
  /** Opens a path mentioned in assistant text in the work dir file panel —
   * `undefined` on compact/iOS, where that panel doesn't exist (see
   * `Message.tsx`'s `AssistantText`). */
  onOpenPath?: (path: string) => void;
  /** The session's working directory — a tool call's header shows the file
   * it touched relative to this, not as the relay's absolute path. */
  cwd: string | null;
  /** Whether this tab is the one currently on screen — background tabs stay
   * mounted (`invisible` in `TabGroupLayout`'s flat panel layer), so this is the
   * only signal telling this instance it just came back into view. See the
   * re-pin effect below for why that matters. */
  isActiveTab: boolean;
  /** Rendered as the log's last item, right after the latest message — the
   * background work this conversation launched. In the scrolling flow rather than pinned above the composer,
   * so it reads as part of the conversation and scrolls away with it. The
   * caller memoizes it: a fresh element on every render would defeat this
   * component's `memo`. */
  trailing?: ReactNode;
}

export interface MessageLogHandle {
  /** Smooth-scrolls to the end of the conversation and re-pins it there. */
  scrollToEnd: () => void;
}

/** Key of the synthetic last item holding `trailing`. */
const TRAILING_KEY = "__trailing";

type RenderItem = TimelineItem | { kind: "trailing" };

function itemKey(item: RenderItem): string {
  if (item.kind === "trailing") return TRAILING_KEY;
  return item.kind === "group" ? `group-${item.id}` : item.entry.id;
}

interface UserActionHandlers {
  editingMessageId: string | null;
  onStartEdit: (id: string, text: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string, text: string) => void;
  onCopy: (text: string) => void;
  onOpenPath?: (path: string) => void;
  cwd: string | null;
}

function renderItem(item: Exclude<RenderItem, { kind: "trailing" }>, userActions: UserActionHandlers, attributionByToolUseId: Record<string, AttributionState>, dict: Dictionary) {
  if (item.kind === "group") {
    return (
      <LogEntryRow key={`group-${item.id}`}>
        <ActivityGroup
          id={item.id}
          calls={item.calls}
          attributionByToolUseId={attributionByToolUseId}
          cwd={userActions.cwd}
          onCopy={userActions.onCopy}
          onOpenPath={userActions.onOpenPath}
        />
      </LogEntryRow>
    );
  }

  const entry = item.entry;
  switch (entry.kind) {
    case "user":
      return (
        <UserBubble
          key={entry.id}
          id={entry.id}
          text={entry.text}
          images={entry.images}
          sentAt={entry.sentAt}
          isEditing={userActions.editingMessageId === entry.id}
          onStartEdit={userActions.onStartEdit}
          onCancelEdit={userActions.onCancelEdit}
          onSaveEdit={userActions.onSaveEdit}
          onCopy={userActions.onCopy}
        />
      );
    case "text":
      return (
        <LogEntryRow key={entry.id}>
          <AssistantText
            text={entry.text}
            streaming={entry.streaming}
            onCopy={userActions.onCopy}
            onOpenPath={userActions.onOpenPath}
          />
        </LogEntryRow>
      );
    case "tool-call":
      return (
        <LogEntryRow key={entry.id}>
          <ToolCallCard call={entry} />
        </LogEntryRow>
      );
    case "thinking":
      return (
        <LogEntryRow key={entry.id}>
          <ThinkingRow entry={entry} />
        </LogEntryRow>
      );
    case "turn-footer":
      return (
        <LogEntryRow key={entry.id} className="py-0">
          <TurnFooter sentAt={entry.sentAt} durationMs={entry.durationMs} text={entry.text} onCopy={userActions.onCopy} />
        </LogEntryRow>
      );
    case "error":
      return (
        <LogEntryRow key={entry.id}>
          <ErrorMessage message={entry.message} />
        </LogEntryRow>
      );
    case "stopped":
      return (
        <LogEntryRow key={entry.id}>
          <p className="font-mono text-[11px] text-text-faint">{dict.chat.log.stopped}</p>
        </LogEntryRow>
      );
    case "background-job-note":
      return (
        <LogEntryRow key={entry.id}>
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-text-faint">
            <Loader2 className="size-3 shrink-0" />
            <span className="truncate">{dict.chat.log.backgroundJobDone.replace("{label}", entry.label)}</span>
          </p>
        </LogEntryRow>
      );
    case "wakeup-note":
      return (
        <LogEntryRow key={entry.id}>
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-text-faint">
            <Loader2 className="size-3 shrink-0" />
            <span className="truncate">{dict.chat.log.wakeupResumed}</span>
          </p>
        </LogEntryRow>
      );
    default:
      return null;
  }
}

// Memoized: `ChatPanel` re-renders for reasons that have nothing to do with
// the log — a turn starting, the connection flapping, the dock opening —
// and it is mounted for every open tab at once (TabGroupLayout's flat panel
// layer), not just the visible one. `entries`/`streamingEntries` stay
// referentially stable across those unrelated re-renders (see useMessageLog),
// so wrapping this in `memo` lets the expensive subtree (markdown parsing +
// syntax highlighting in every row) bail out instead of re-rendering along
// with `ChatPanel`. `TabPanel`'s own `memo` is the outer half of this: it
// keeps App-level state changes from reaching `ChatPanel` at all.
export const MessageLog = memo(forwardRef<MessageLogHandle, MessageLogProps>(function MessageLog({
  entries,
  streamingEntries,
  attributionByToolUseId,
  hasMoreHistory,
  loadingOlderHistory,
  onLoadOlderHistory,
  className,
  style,
  endInsetKey,
  onScrollToEndVisibleChange,
  onUserScrollStart,
  editingMessageId,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onCopy,
  onOpenPath,
  cwd,
  isActiveTab,
  trailing,
}: MessageLogProps, ref) {
  const parentRef = useRef<HTMLDivElement>(null);
  const dict = useDict();
  const userActions: UserActionHandlers = { editingMessageId, onStartEdit, onCancelEdit, onSaveEdit, onCopy, onOpenPath, cwd };

  // Which rows are expanded, for this tab — held here, above the virtualized
  // list, so a row that scrolls out of view keeps its state.
  const [openState] = useState(() => new OpenState());

  // `entries` only gets a new reference when something is actually
  // committed (see reducer in useMessageLog) — memoizing here avoids
  // regrouping on every streaming token, when only `streamingEntries`
  // changes.
  const items = useMemo(() => buildTimeline(entries), [entries]);

  const hasTrailing = trailing !== undefined && trailing !== null && trailing !== false;
  const allItems = useMemo<RenderItem[]>(
    () => [
      ...items,
      ...streamingEntries.map((entry): RenderItem => ({ kind: "single", entry })),
      ...(hasTrailing ? [{ kind: "trailing" } as const] : []),
    ],
    [items, streamingEntries, hasTrailing],
  );

  const getItemKey = useCallback((index: number) => itemKey(allItems[index]), [allItems]);

  // Guards against a flicker found while watching a growing tool card (e.g.
  // Edit's diff still streaming in): @tanstack/react-virtual's own
  // `resizeItem` re-pins the viewport to the end whenever an item resizes
  // and the scroll is within `scrollEndThreshold` — but that check doesn't
  // look at scroll direction (unlike the sibling branch that adjusts for an
  // item resizing above the fold, which explicitly skips itself during
  // backward scroll to avoid the same kind of cascade). So scrolling up
  // while still inside the threshold gets fought, tick by tick, by every
  // resize the streaming card triggers. Tracking direction ourselves in
  // `handleScroll` below and collapsing the threshold to ~0 while the user
  // is scrolling up closes that gap — it only re-arms once they're back
  // essentially at the bottom.
  const pinnedToBottomRef = useRef(true);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const prevScrollTopRef = useRef(0);

  // Tells apart a real user gesture from a programmatic scroll — both fire
  // the same native `scroll` event, but only the former should be allowed to
  // unpin. Found while chasing a report that auto-follow silently stopped
  // mid-turn even though the user never scrolled: the virtualizer corrects
  // `scrollTop` on its own the moment `measureElement` replaces an item's
  // estimated height (88, see `estimateSize` below) with the real one — if
  // the real height is smaller, that correction nudges `scrollTop` backward
  // by a few px, which `handleScroll` below then can't distinguish from the
  // user scrolling up. Without this gate that harmless nudge was enough to
  // unpin permanently (dropping `scrollEndThreshold` to 0 disables react-
  // virtual's own `followOnAppend` snap too, not just ours) until the user
  // scrolled all the way back down by hand.
  const userScrollingRef = useRef(false);
  const userScrollingTimeoutRef = useRef<number | undefined>(undefined);
  const onUserScrollStartRef = useRef(onUserScrollStart);
  onUserScrollStartRef.current = onUserScrollStart;
  const onScrollToEndVisibleChangeRef = useRef(onScrollToEndVisibleChange);
  onScrollToEndVisibleChangeRef.current = onScrollToEndVisibleChange;
  const scrollToEndVisibleRef = useRef(false);

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const markUserScrolling = () => {
      userScrollingRef.current = true;
      window.clearTimeout(userScrollingTimeoutRef.current);
      userScrollingTimeoutRef.current = window.setTimeout(() => {
        userScrollingRef.current = false;
      }, 150);
    };
    const onTouchMove = () => {
      markUserScrolling();
      onUserScrollStartRef.current?.();
    };
    el.addEventListener("wheel", markUserScrolling, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", markUserScrolling);
      el.removeEventListener("touchmove", onTouchMove);
      window.clearTimeout(userScrollingTimeoutRef.current);
    };
  }, []);

  // Virtualized — long conversations (hundreds of tool calls/code blocks
  // with syntax highlighting) got heavy even with the memoization above,
  // because the whole list stayed mounted in the DOM. `anchorTo: "end"` +
  // `measureElement` (dynamic height — items vary a lot: short bubble, long
  // code block, expandable tool card) keep the end pinned while the last
  // message grows during streaming, same as the old `scrollIntoView`.
  // `followOnAppend` is what solves the user's request: it only follows a
  // new message if the viewport was already at the end — if they scrolled
  // up reading history while the agent works, scroll isn't forced back down
  // (official @tanstack/react-virtual docs, "chat" section).
  // `useFlushSync: false` is the official recommendation to avoid a
  // warning/extra cost in React 19.
  const virtualizer = useVirtualizer({
    count: allItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 88,
    getItemKey,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: pinnedToBottom ? 80 : 0,
    overscan: 8,
    useFlushSync: false,
  });

  // Opens the tab already at the end of the conversation (equivalent to the
  // old scrollIntoView on first mount) — from then on `anchorTo`/
  // `followOnAppend` above take care of keeping it pinned to the end. No
  // "only once" guard: in StrictMode (dev) React unmounts and remounts the
  // container's real node right after the first fire to test effect
  // cleanup — a guard here would block the second call, which is the one
  // that runs on the final DOM node (the first targets a discarded node).
  // `virtualizer` is a stable instance (doesn't change identity on normal
  // re-renders), so in production this really only runs once, matching the
  // pattern recommended by the library.
  useLayoutEffect(() => {
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  // Reported bug: pinned to bottom, switch to another tab, new turns arrive
  // in the background, switch back — the log came back at the OLD bottom
  // (now short of the real one) instead of following the new messages.
  // `followOnAppend` is supposed to keep a backgrounded tab pinned on its
  // own (the box isn't collapsed while hidden — see the `invisible` comment
  // in `TabGroupLayout` — so its measurements stay live), but there's evidently a
  // gap somewhere in that chain for a tab that isn't the one actually on
  // screen. Rather than chase that gap, re-sync straight from the live DOM
  // (same `scrollHeight`/`clientHeight` read as the effect above, not the
  // virtualizer's own bookkeeping) the moment this tab becomes active again
  // — but only if it was genuinely pinned before backgrounding; a tab left
  // scrolled up into history should come back exactly where it was.
  const wasActiveRef = useRef(isActiveTab);
  useLayoutEffect(() => {
    const becameActive = isActiveTab && !wasActiveRef.current;
    wasActiveRef.current = isActiveTab;
    if (!becameActive || !pinnedToBottomRef.current) return;
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [isActiveTab]);

  // The composer grew or the keyboard moved: keep the end in view if that is
  // where the user was. Next frame, so the new padding has been laid out.
  useLayoutEffect(() => {
    if (endInsetKey === undefined || !pinnedToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const el = parentRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [endInsetKey]);

  const scrollToEndSettleRef = useRef<number | undefined>(undefined);
  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd: () => {
        const el = parentRef.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        // Row heights can still correct themselves on the way down; once the
        // smooth scroll has landed, let the virtualizer land the last stretch.
        window.clearTimeout(scrollToEndSettleRef.current);
        scrollToEndSettleRef.current = window.setTimeout(() => virtualizer.scrollToEnd(), 400);
      },
    }),
    [virtualizer],
  );
  useLayoutEffect(() => () => window.clearTimeout(scrollToEndSettleRef.current), []);

  // Reverse scroll: stores the total height at the
  // instant the request for older turns fires — there's no way to know in
  // advance when the response arrives, so this is the only reliable moment
  // to capture the "before". `null` when no compensation is in progress.
  const prependAnchorRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;

    const scrollTop = el.scrollTop;
    const scrolledUp = scrollTop < prevScrollTopRef.current - 1;
    prevScrollTopRef.current = scrollTop;
    const distanceFromEnd = el.scrollHeight - scrollTop - el.clientHeight;
    if (pinnedToBottomRef.current && userScrollingRef.current && scrolledUp && distanceFromEnd > 4) {
      pinnedToBottomRef.current = false;
      setPinnedToBottom(false);
    } else if (!pinnedToBottomRef.current && distanceFromEnd <= 4) {
      pinnedToBottomRef.current = true;
      setPinnedToBottom(true);
    }

    const showArrow = nextScrollToEndVisible(scrollToEndVisibleRef.current, { distanceFromEnd, viewportHeight: el.clientHeight });
    if (showArrow !== scrollToEndVisibleRef.current) {
      scrollToEndVisibleRef.current = showArrow;
      onScrollToEndVisibleChangeRef.current?.(showArrow);
    }

    if (scrollTop > 120 || loadingOlderHistory || !hasMoreHistory) return;
    prependAnchorRef.current = virtualizer.getTotalSize();
    onLoadOlderHistory();
  }, [hasMoreHistory, loadingOlderHistory, onLoadOlderHistory, virtualizer]);

  // Found while testing with real-sized content (code blocks, long texts):
  // compensating scroll just once (on the first height change after the
  // prepend) wasn't enough — new items come in with the ESTIMATED height
  // (`estimateSize: 88`), `measureElement` only measures the real one
  // asynchronously (ResizeObserver) after the DOM has already painted, and
  // that size correction arrives at a TOTAL height different from the one
  // we'd already compensated for — without handling this, the scroll
  // "jitters" (goes down a bit, back up) while the real measurements keep
  // arriving. That's why this effect runs on EVERY render where `totalSize`
  // changed (not just once per prepend) while the anchor is active, and
  // only releases the anchor after ~300ms with no size change — a sign the
  // measurements have settled. The short window matters: keeping the anchor
  // held for too long would start "correcting" a live turn growing at the
  // end too, which `anchorTo`/`followOnAppend` already handle on their own.
  const totalSize = virtualizer.getTotalSize();
  const settleTimeoutRef = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    const el = parentRef.current;
    if (anchor === null || !el) return;
    const delta = totalSize - anchor;
    if (delta !== 0) el.scrollTop += delta;
    prependAnchorRef.current = totalSize;

    window.clearTimeout(settleTimeoutRef.current);
    settleTimeoutRef.current = window.setTimeout(() => {
      prependAnchorRef.current = null;
    }, 300);

    return () => window.clearTimeout(settleTimeoutRef.current);
  }, [totalSize]);

  return (
    // `relative` isn't about layout — it's the fix for a real WebKit bug
    // (reproduced via real WebKit Playwright, not Chromium):
    // `backdrop-filter` on an ancestor doesn't sample this div's content if
    // it (or any ancestor between it and the blurred element) is
    // `position: static`. The whole chain up to the root needs this
    // — see App.tsx (tab wrappers). Do not remove.
    <OpenStateContext.Provider value={openState}>
    <div
      ref={parentRef}
      onScroll={handleScroll}
      style={style}
      // Explicit `overflow-x-hidden`, not just its absence: without this the
      // X axis inherits the computed `auto` value (overflow spec rule — a
      // non-`visible` `overflow-y` forces the other axis to `auto` too),
      // which opens up horizontal scroll as soon as any content (a long
      // path in `code`, for instance) overflows the width by even 1px.
      className={cn(
        "selectable-content scrollbar-thin relative flex-1 overflow-x-hidden overflow-y-auto px-4 py-3",
        className,
      )}
    >
      {loadingOlderHistory && (
        <div className="sticky top-0 z-10 flex justify-center py-1.5">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}
      <div className="mx-auto max-w-3xl" style={{ position: "relative", width: "100%", height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = allItems[virtualItem.index];
          if (!item) return null;
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                // Replaces the old flex layout's `gap-1` — items are now
                // positioned via `transform`, out of flow, so the spacing
                // between them has to come from within each one.
                paddingBottom: "0.25rem",
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {item.kind === "trailing" ? trailing : renderItem(item, userActions, attributionByToolUseId, dict)}
            </div>
          );
        })}
      </div>
    </div>
    </OpenStateContext.Provider>
  );
}));
