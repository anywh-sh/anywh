import { useCallback, useEffect, useRef, useState } from "react";

/** Right-side dock, one per chat session (tab) — replaces `useSessionPanels.ts`:
 * terminal and the work dir file viewer aren't
 * mutually exclusive content of a single slot, they're independent panes
 * that stack in the same column. `panes` is the stack, top to bottom;
 * pushing a kind that's already there is a no-op from the caller's
 * perspective (use `togglePane`, which removes it instead).
 */
export type DockPaneKind = "terminal" | "files";

export interface DockState {
  /** Visual order, top to bottom. Empty = dock closed. */
  panes: DockPaneKind[];
  /** Column width — shared by every pane, not per pane. */
  width: number;
  /** Fraction of the column height the first pane in `panes` gets, when
   * there are two. Clamped to [0.2, 0.8] so neither pane can be dragged
   * down to nothing. */
  splitRatio: number;
  /** Which pane is expanded to fill the whole column (hiding the chat and
   * the other pane), `null` for the normal split layout. */
  maximized: DockPaneKind | null;
}

const MIN_WIDTH = 320;
// The file pane is a tree + content side by side — below this the two
// become unusable, unlike the terminal alone which tolerates the narrower
// default.
export const MIN_WIDTH_WITH_FILES = 420;
const MAX_WIDTH = 900;
// Floor for how much of a group's own width should stay usable as chat once
// a dock with the files pane sits at its own minimum (`MIN_WIDTH_WITH_FILES`)
// next to it — feeds `useGroupSizeDrag`'s `MIN_GROUP_PX`. Doesn't protect
// against the dock being dragged wider than its minimum in an already-narrow
// group (that would need `clampWidth` to know the group's live rendered
// width, not just its own pane kind — not wired yet, tracked as a known gap
// rather than solved preventively here).
export const MIN_USABLE_CHAT_PX = 480;
const DEFAULT_WIDTH = 480;
const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;

const STORAGE_KEY = "anywh:session-dock";
// Old single-slot shape (`{ open, kind, width, maximized }`) this hook
// replaces — not migrated: what's lost is just "this panel was open, with
// this width", not worth preserving.
const OLD_STORAGE_KEY = "anywh:session-panels";

type DockMap = Record<string, DockState>;

function clampWidth(width: number, panes: DockPaneKind[]): number {
  const min = panes.includes("files") ? MIN_WIDTH_WITH_FILES : MIN_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(min, width));
}

function clampSplitRatio(ratio: number): number {
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

function loadPersisted(): DockMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as DockMap;
  } catch {
    return {};
  }
}

const EMPTY_DOCK: DockState = { panes: [], width: DEFAULT_WIDTH, splitRatio: 0.5, maximized: null };

function withoutPane(dock: DockState, kind: DockPaneKind): DockState {
  if (!dock.panes.includes(kind)) return dock;
  return {
    ...dock,
    panes: dock.panes.filter((pane) => pane !== kind),
    maximized: dock.maximized === kind ? null : dock.maximized,
  };
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
  // (width/split-ratio resize), so the effect below skips that write —
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
  }, []);

  const getDock = useCallback((tabId: string): DockState => docks[tabId] ?? EMPTY_DOCK, [docks]);

  /** If `kind` is already open, closes it; otherwise pushes it to the end of
   * the stack — with the terminal already open, files lands below it, and
   * vice versa. */
  const togglePane = useCallback((tabId: string, kind: DockPaneKind) => {
    setDocks((prev) => {
      const existing = prev[tabId] ?? EMPTY_DOCK;
      if (existing.panes.includes(kind)) {
        return { ...prev, [tabId]: withoutPane(existing, kind) };
      }
      return { ...prev, [tabId]: { ...existing, panes: [...existing.panes, kind] } };
    });
  }, []);

  /** Ensures `kind` is present, without `togglePane`'s close-if-already-open
   * behavior — for actions that only ever mean "show me this pane" (the file
   * tree's "open in terminal"), never "close it". */
  const openPane = useCallback((tabId: string, kind: DockPaneKind) => {
    setDocks((prev) => {
      const existing = prev[tabId] ?? EMPTY_DOCK;
      if (existing.panes.includes(kind)) return prev;
      return { ...prev, [tabId]: { ...existing, panes: [...existing.panes, kind] } };
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

  const setSplitRatio = useCallback((tabId: string, ratio: number) => {
    suppressPersistRef.current = true;
    setDocks((prev) => {
      const existing = prev[tabId];
      if (!existing) return prev;
      return { ...prev, [tabId]: { ...existing, splitRatio: clampSplitRatio(ratio) } };
    });
  }, []);

  /** Flushes the current dock state to storage — call on drag end (pointer
   * up) after a `setWidth`/`setSplitRatio` sequence, whose per-frame calls
   * skip the write via `suppressPersistRef` to avoid blocking the main
   * thread on every `pointermove` (same fix as `useResizableSidebar.ts`). */
  const commitDock = useCallback(() => {
    setDocks((prev) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prev));
      return prev;
    });
  }, []);

  /** Expanding doesn't touch `panes`/`splitRatio` — restoring means going
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

  return { getDock, togglePane, openPane, closePane, setWidth, setSplitRatio, commitDock, toggleMaximized, removeSession };
}
