import { useCallback, useEffect, useRef, useState } from "react";

/** Right-side dock, one per chat session (tab) — replaces `useSessionPanels.ts`:
 * terminal and the work dir file viewer aren't
 * mutually exclusive content of a single slot, they're independent panes
 * that stack in the same column. `panes` is the stack, top to bottom;
 * pushing a kind that's already there is a no-op from the caller's
 * perspective (use `togglePane`, which removes it instead).
 *
 * `agent` and `about` are a room's: one agent's conversation, and the room's
 * own information. Only a room's tab ever opens them.
 *
 * `none` is the "no selection" view: the panel is open but nothing was picked
 * in it yet, so it draws an empty state that asks for a choice. It is what a
 * non-room tab's panel shows the first time it opens, and the place future
 * views (integrations, ...) are chosen from.
 */
export type DockPaneKind = "none" | "terminal" | "files" | "agent" | "about";

const PANE_KINDS: readonly DockPaneKind[] = ["none", "terminal", "files", "agent", "about"];
/** How many panes the column holds at once: one view, and opening another
 * switches to it. */
export const MAX_DOCK_PANES = 1;

export interface DockState {
  /** Visual order, top to bottom. Empty = dock closed. */
  panes: DockPaneKind[];
  /** Column width — shared by every pane, not per pane. */
  width: number;
  /** Which pane is expanded to fill the whole plane (hiding the chat),
   * `null` for the normal layout. */
  maximized: DockPaneKind | null;
  /** The pane opened last on this tab, kept after it is closed: it is what
   * showing a side panel that has nothing open brings up. Absent on a tab
   * that never opened one. */
  last?: DockPaneKind;
  /** The tab's panel is hidden by the strip's toggle. Hiding is not closing:
   * `panes` stay as they were, so showing the panel again brings back exactly
   * what was there. Per tab, not per group — each session keeps its own
   * panel open or closed. */
  hidden?: true;
}

const MIN_WIDTH = 320;
// The file pane is a tree + content side by side — below this the two
// become unusable, unlike the terminal alone which tolerates the narrower
// default.
export const MIN_WIDTH_WITH_FILES = 420;
const MAX_WIDTH = 900;
// A room pane holds a whole conversation, or the room's figures: narrower than
// this and the chat's composer wraps into nothing.
const MIN_WIDTH_ROOM_PANE = 385;
// Floor for how much of a group's own width should stay usable as chat once
// a dock with the files pane sits at its own minimum (`MIN_WIDTH_WITH_FILES`)
// next to it — feeds `useGroupSizeDrag`'s `MIN_GROUP_PX`. Doesn't protect
// against the dock being dragged wider than its minimum in an already-narrow
// group (that would need `clampWidth` to know the group's live rendered
// width, not just its own pane kind — not wired yet, tracked as a known gap
// rather than solved preventively here).
export const MIN_USABLE_CHAT_PX = 480;
export const DEFAULT_DOCK_WIDTH = 480;

const STORAGE_KEY = "anywh:session-dock";
// Old single-slot shape (`{ open, kind, width, maximized }`) this hook
// replaces — not migrated: what's lost is just "this panel was open, with
// this width", not worth preserving.
const OLD_STORAGE_KEY = "anywh:session-panels";

type DockMap = Record<string, DockState>;

// Where the panel's visibility used to be kept, per tab group — it made every
// session in a group share one open/closed state. Now a flag of each tab's dock.
const OLD_HIDDEN_STORAGE_KEY = "anywh:right-panel-hidden";

/** The narrowest and widest the column may be with these panes in it. */
export function dockWidthBounds(panes: readonly DockPaneKind[]): { min: number; max: number } {
  const min = panes.includes("files")
    ? MIN_WIDTH_WITH_FILES
    : panes.includes("agent") || panes.includes("about")
      ? MIN_WIDTH_ROOM_PANE
      : MIN_WIDTH;
  return { min, max: MAX_WIDTH };
}

function clampWidth(width: number, panes: DockPaneKind[]): number {
  const { min, max } = dockWidthBounds(panes);
  return Math.min(max, Math.max(min, width));
}

/** Stored docks are read back as they were written, by this build or another:
 * kinds this one does not know, repeats and a stack past the limit are dropped
 * rather than drawn. */
function sanitizeDocks(docks: DockMap): DockMap {
  const known = (kind: unknown): kind is DockPaneKind => PANE_KINDS.includes(kind as DockPaneKind);
  const result: DockMap = {};
  for (const [tabId, dock] of Object.entries(docks)) {
    const panes = (Array.isArray(dock.panes) ? dock.panes : []).filter((kind, index, all) => known(kind) && all.indexOf(kind) === index).slice(-MAX_DOCK_PANES);
    // A dock written when two panes could share the column carries a split
    // ratio that nothing reads any more.
    const { splitRatio: _legacySplitRatio, ...current } = dock as DockState & { splitRatio?: number };
    result[tabId] = {
      ...current,
      panes,
      maximized: dock.maximized !== null && panes.includes(dock.maximized) ? dock.maximized : null,
      last: known(dock.last) ? dock.last : undefined,
    };
    if (result[tabId].last === undefined) delete result[tabId].last;
    if (dock.hidden === true) result[tabId].hidden = true;
    else delete result[tabId].hidden;
  }
  return result;
}

function loadPersisted(): DockMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return sanitizeDocks(JSON.parse(raw) as DockMap);
  } catch {
    return {};
  }
}

const EMPTY_DOCK: DockState = { panes: [], width: DEFAULT_DOCK_WIDTH, maximized: null };

/** Closing a view drops the panel back to the "no selection" pane rather than
 * shutting the column: the panel is hidden only by its own toggle, or by
 * closing `none` itself. */
function withoutPane(dock: DockState, kind: DockPaneKind): DockState {
  if (!dock.panes.includes(kind)) return dock;
  return {
    ...dock,
    panes: kind === "none" ? [] : ["none"],
    maximized: dock.maximized === kind ? null : dock.maximized,
  };
}

/** `kind` added to the end of the stack, closing the oldest pane when the
 * column is already full. The width is clamped here too: it is
 * otherwise only clamped when dragged, so a dock left at the terminal's
 * minimum would stay that narrow when the wider files pane joined it. */
function pushPane(dock: DockState, kind: DockPaneKind): DockState {
  const panes = [...dock.panes, kind].slice(-MAX_DOCK_PANES);
  const maximized = dock.maximized !== null && panes.includes(dock.maximized) ? dock.maximized : null;
  const { hidden: _hidden, ...shown } = dock;
  return { ...shown, panes, maximized, width: clampWidth(dock.width, panes), last: kind };
}

/**
 * State of all the app's right-side docks, one per session tab — same
 * pattern as `useTabs.ts` (a map instead of separate instances), persisted
 * in `localStorage` to survive an app restart. Purely UI state
 * (panes/width/split/maximized): what exists *inside* each pane (e.g. which
 * terminal tabs, which files are open) is another hook's responsibility
 * (`useTerminalTabs`, `useFileTabs`), this one only knows about the shell.
 */
export function useSessionDock() {
  const [docks, setDocks] = useState<DockMap>(loadPersisted);
  // Set right before a `setDocks` call driven by a per-frame drag update
  // (width resize), so the effect below skips that write —
  // `commitDock` flushes the final value once the drag ends instead. Reset
  // after every skip, so a change from any other setter (not drag-driven)
  // persists immediately as before.
  const suppressPersistRef = useRef(false);

  useEffect(() => {
    if (suppressPersistRef.current) {
      suppressPersistRef.current = false;
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(docks));
  }, [docks]);

  useEffect(() => {
    localStorage.removeItem(OLD_STORAGE_KEY);
    localStorage.removeItem(OLD_HIDDEN_STORAGE_KEY);
  }, []);

  const getDock = useCallback((tabId: string): DockState => docks[tabId] ?? EMPTY_DOCK, [docks]);

  /** Whether the side panel is on screen for the tab `tabId`: not hidden, and
   * with something open on it. The toggle's state and the buttons that open
   * its panes both follow this one answer. */
  const isPanelShown = useCallback(
    (tabId: string | null): boolean => {
      if (tabId === null) return false;
      const dock = docks[tabId] ?? EMPTY_DOCK;
      return dock.hidden !== true && dock.panes.length > 0;
    },
    [docks],
  );

  /** The toggle. Shown, it hides the panel — what was open is kept, so
   * showing it again is the undo. Not shown, it shows it, and when the tab
   * has nothing open it opens the pane used last (`fallback` if there never
   * was one: the "no selection" view, or a room's agent), so the panel is
   * never a blank column. */
  const togglePanel = useCallback((tabId: string | null, fallback: DockPaneKind = "none") => {
    if (tabId === null) return;
    setDocks((prev) => {
      const existing = prev[tabId] ?? EMPTY_DOCK;
      if (existing.hidden !== true && existing.panes.length > 0) return { ...prev, [tabId]: { ...existing, hidden: true } };
      if (existing.panes.length > 0) {
        const { hidden: _hidden, ...shown } = existing;
        return { ...prev, [tabId]: shown };
      }
      return { ...prev, [tabId]: pushPane(existing, existing.last ?? fallback) };
    });
  }, []);

  /** The dock as the tab's panel should draw it: the stored one, or — when
   * the tab's panel is hidden — a closed copy of it. The copy is cached per
   * stored dock, so `TabPanel` (memoized on this exact reference) is not
   * re-rendered by a call that returns the same thing it did last time. */
  const closedCopies = useRef(new WeakMap<DockState, DockState>());
  const getVisibleDock = useCallback(
    (tabId: string, groupId: string | null): DockState => {
      const dock = docks[tabId] ?? EMPTY_DOCK;
      if (groupId === null || dock.hidden !== true || dock.panes.length === 0) return dock;
      let closed = closedCopies.current.get(dock);
      if (!closed) {
        closed = { ...dock, panes: [], maximized: null };
        closedCopies.current.set(dock, closed);
      }
      return closed;
    },
    [docks],
  );

  /** If `kind` is already open, closes it; otherwise pushes it to the end of
   * the stack — with the terminal already open, files lands below it, and
   * vice versa. */
  const togglePane = useCallback((tabId: string, kind: DockPaneKind) => {
    setDocks((prev) => {
      const existing = prev[tabId] ?? EMPTY_DOCK;
      // On a hidden panel the pane is not on screen: asking for it means "show
      // me this", not closing something nobody can see.
      if (existing.panes.includes(kind) && existing.hidden !== true) {
        return { ...prev, [tabId]: withoutPane(existing, kind) };
      }
      return { ...prev, [tabId]: pushPane(existing, kind) };
    });
  }, []);

  /** Ensures `kind` is present, without `togglePane`'s close-if-already-open
   * behavior — for actions that only ever mean "show me this pane" (the file
   * tree's "open in terminal"), never "close it". */
  const openPane = useCallback((tabId: string, kind: DockPaneKind) => {
    setDocks((prev) => {
      const existing = prev[tabId] ?? EMPTY_DOCK;
      if (existing.panes.includes(kind) && existing.hidden !== true) return prev;
      return { ...prev, [tabId]: pushPane(existing, kind) };
    });
  }, []);

  const closePane = useCallback((tabId: string, kind: DockPaneKind) => {
    setDocks((prev) => {
      const existing = prev[tabId];
      if (!existing) return prev;
      return { ...prev, [tabId]: withoutPane(existing, kind) };
    });
  }, []);

  const setWidth = useCallback((tabId: string, width: number) => {
    suppressPersistRef.current = true;
    setDocks((prev) => {
      const existing = prev[tabId];
      if (!existing) return prev;
      return { ...prev, [tabId]: { ...existing, width: clampWidth(width, existing.panes) } };
    });
  }, []);

  /** Flushes the current dock state to storage — call on drag end (pointer
   * up) after a `setWidth` sequence, whose per-frame calls
   * skip the write via `suppressPersistRef` to avoid blocking the main
   * thread on every `pointermove` (same fix as `useResizableSidebar.ts`). */
  const commitDock = useCallback(() => {
    setDocks((prev) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prev));
      return prev;
    });
  }, []);

  /** Expanding doesn't touch `panes` — restoring means going
   * back to whatever layout was there before, for free. */
  const toggleMaximized = useCallback((tabId: string, kind: DockPaneKind) => {
    setDocks((prev) => {
      const existing = prev[tabId];
      if (!existing) return prev;
      return { ...prev, [tabId]: { ...existing, maximized: existing.maximized === kind ? null : kind } };
    });
  }, []);

  /** Called when the chat tab is closed/deleted — without this the map keeps
   * growing forever with entries for sessions that no longer exist. */
  const removeSession = useCallback((tabId: string) => {
    setDocks((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  return { getDock, getVisibleDock, isPanelShown, togglePanel, togglePane, openPane, closePane, setWidth, commitDock, toggleMaximized, removeSession };
}
