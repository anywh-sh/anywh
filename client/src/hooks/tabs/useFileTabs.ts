import { useCallback, useEffect, useState } from "react";

export interface FileTabEntry {
  path: string;
  /** Preview (unpinned) vs. pinned tab — see `openPreview`/`openPinned`
   * below: a single click reuses/replaces the one
   * preview tab, a double click (or "open in new tab") pins it. */
  pinned: boolean;
}

interface FileTabsState {
  open: FileTabEntry[];
  activePath: string | null;
  /** Directories currently expanded in the tree, persisted so reopening the
   * panel doesn't collapse everything. */
  expanded: string[];
  /** Left column (tree) width, independent of the dock column's own width. */
  treeWidth: number;
  /** Last root confirmed by the relay (`/files/list`'s own `root` field) —
   * `null` until the first fetch resolves. Used by `syncRoot` to notice the
   * session's cwd changed since last time. */
  root: string | null;
}

const STORAGE_KEY = "anywh:file-tabs";
const DEFAULT_TREE_WIDTH = 180;
const EMPTY_STATE: FileTabsState = { open: [], activePath: null, expanded: [], treeWidth: DEFAULT_TREE_WIDTH, root: null };

type FileTabsMap = Record<string, FileTabsState>;

function loadPersisted(): FileTabsMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as FileTabsMap;
  } catch {
    return {};
  }
}

/**
 * Content specific to the dock's `"files"` pane (see useSessionDock.ts) —
 * which files are open, which one's active, which tree folders are
 * expanded, and the tree column's width. Deliberately separate from the
 * dock's own shell state, same split `useTerminalTabs` already does for the
 * terminal pane.
 */
export function useFileTabs() {
  const [state, setState] = useState<FileTabsMap>(loadPersisted);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const getTabs = useCallback((tabId: string): FileTabsState => state[tabId] ?? EMPTY_STATE, [state]);

  /** Single click in the tree — VS Code/Claude Desktop convention: activates
   * an already-pinned tab for this path if there is one, otherwise
   * replaces the one unpinned "preview" tab in place (creating it at the
   * end if there wasn't one yet). */
  const openPreview = useCallback((tabId: string, path: string) => {
    setState((prev) => {
      const existing = prev[tabId] ?? EMPTY_STATE;
      if (existing.open.some((tab) => tab.path === path && tab.pinned)) {
        return { ...prev, [tabId]: { ...existing, activePath: path } };
      }
      const previewIndex = existing.open.findIndex((tab) => !tab.pinned);
      const entry: FileTabEntry = { path, pinned: false };
      const open =
        previewIndex === -1 ? [...existing.open, entry] : existing.open.map((tab, i) => (i === previewIndex ? entry : tab));
      return { ...prev, [tabId]: { ...existing, open, activePath: path } };
    });
  }, []);

  /** Double click, or "open in new tab" — pins a tab for `path`, reusing one
   * that already exists (whether it was preview or already pinned). */
  const openPinned = useCallback((tabId: string, path: string) => {
    setState((prev) => {
      const existing = prev[tabId] ?? EMPTY_STATE;
      const matchIndex = existing.open.findIndex((tab) => tab.path === path);
      const open =
        matchIndex === -1
          ? [...existing.open, { path, pinned: true }]
          : existing.open.map((tab, i) => (i === matchIndex ? { ...tab, pinned: true } : tab));
      return { ...prev, [tabId]: { ...existing, open, activePath: path } };
    });
  }, []);

  const closeTab = useCallback((tabId: string, path: string) => {
    setState((prev) => {
      const existing = prev[tabId];
      if (!existing) return prev;
      const open = existing.open.filter((tab) => tab.path !== path);
      const activePath = existing.activePath === path ? (open[open.length - 1]?.path ?? null) : existing.activePath;
      return { ...prev, [tabId]: { ...existing, open, activePath } };
    });
  }, []);

  /** A file open in a tab got renamed via the context menu — moves its tab
   * (and the active/expanded state pointing at it) to the new path instead
   * of just closing it, so the user doesn't lose their place. */
  const renamePath = useCallback((tabId: string, oldPath: string, newPath: string) => {
    setState((prev) => {
      const existing = prev[tabId];
      if (!existing) return prev;
      const open = existing.open.map((tab) => (tab.path === oldPath ? { ...tab, path: newPath } : tab));
      const activePath = existing.activePath === oldPath ? newPath : existing.activePath;
      return { ...prev, [tabId]: { ...existing, open, activePath } };
    });
  }, []);

  const setActiveFile = useCallback((tabId: string, path: string) => {
    setState((prev) => {
      const existing = prev[tabId];
      if (!existing) return prev;
      return { ...prev, [tabId]: { ...existing, activePath: path } };
    });
  }, []);

  const toggleExpanded = useCallback((tabId: string, dirPath: string) => {
    setState((prev) => {
      const existing = prev[tabId] ?? EMPTY_STATE;
      const expanded = existing.expanded.includes(dirPath)
        ? existing.expanded.filter((path) => path !== dirPath)
        : [...existing.expanded, dirPath];
      return { ...prev, [tabId]: { ...existing, expanded } };
    });
  }, []);

  /** Ensures every dir in `dirPaths` is expanded, additively — unlike
   * `toggleExpanded`, never collapses one that's already open. Used when a
   * chat path click resolves an ancestor chain (`App.tsx`'s
   * `handleOpenFilePath`) and needs all of it visible at once, not just the
   * single folder a tree click would target. */
  const expandDirs = useCallback((tabId: string, dirPaths: string[]) => {
    setState((prev) => {
      const existing = prev[tabId] ?? EMPTY_STATE;
      const merged = Array.from(new Set([...existing.expanded, ...dirPaths]));
      if (merged.length === existing.expanded.length) return prev;
      return { ...prev, [tabId]: { ...existing, expanded: merged } };
    });
  }, []);

  const setTreeWidth = useCallback((tabId: string, width: number) => {
    setState((prev) => {
      const existing = prev[tabId] ?? EMPTY_STATE;
      return { ...prev, [tabId]: { ...existing, treeWidth: Math.min(400, Math.max(120, width)) } };
    });
  }, []);

  /** Compares the just-fetched root against the persisted one — if the cwd
   * changed since last time (only possible before the
   * first turn locks it), everything tied to paths under the old root
   * (open tabs, active file, expanded folders) is stale and gets cleared;
   * `treeWidth` survives, it's not path-based. The very first call for a
   * tab (no persisted root yet) just records it — nothing to reset. */
  const syncRoot = useCallback((tabId: string, newRoot: string) => {
    setState((prev) => {
      const existing = prev[tabId] ?? EMPTY_STATE;
      if (existing.root === newRoot) return prev;
      if (existing.root === null) return { ...prev, [tabId]: { ...existing, root: newRoot } };
      return { ...prev, [tabId]: { ...EMPTY_STATE, root: newRoot, treeWidth: existing.treeWidth } };
    });
  }, []);

  /** Called when the chat tab is closed/deleted — same cleanup as
   * `useTerminalTabs.removeSession`. */
  const removeSession = useCallback((tabId: string) => {
    setState((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  return {
    getTabs,
    openPreview,
    openPinned,
    closeTab,
    renamePath,
    setActiveFile,
    toggleExpanded,
    expandDirs,
    setTreeWidth,
    syncRoot,
    removeSession,
  };
}
