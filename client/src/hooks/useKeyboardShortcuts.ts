import { useEffect, useRef } from "react";

export type ShortcutId =
  | "cycle-tab-next"
  | "cycle-tab-prev"
  | "toggle-terminal"
  | "toggle-files"
  | "split-tab"
  | "new-conversation"
  | "close-tab"
  | "toggle-sidebar"
  | "focus-group-1"
  | "focus-group-2"
  | "focus-group-3";

type ShortcutKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey">;

/** Pure key→command table, kept separate from the `window.addEventListener`
 * wiring below so it can be unit-tested without a DOM. Order matters and
 * mirrors the original inline handler exactly:
 *
 * - The four `Ctrl`-only shortcuts (never `metaKey`, even on macOS — they're
 *   VS Code's own conventions, and Cmd+Tab/Cmd+` are already OS shortcuts
 *   there) are checked first and are mutually exclusive with everything else.
 * - Everything else requires `metaKey || ctrlKey` (Cmd on macOS, Ctrl on
 *   Windows/Linux) and falls through a plain `key` switch.
 */
export function matchShortcut(event: ShortcutKeyEvent): ShortcutId | null {
  if (event.ctrlKey && event.key === "Tab") return event.shiftKey ? "cycle-tab-prev" : "cycle-tab-next";
  if (event.ctrlKey && event.key === "`") return "toggle-terminal";
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e") return "toggle-files";
  if (event.ctrlKey && event.key === "\\") return "split-tab";
  if (!(event.metaKey || event.ctrlKey)) return null;
  switch (event.key.toLowerCase()) {
    case "n":
      return "new-conversation";
    case "w":
      return "close-tab";
    case "b":
      return "toggle-sidebar";
    case "1":
      return "focus-group-1";
    case "2":
      return "focus-group-2";
    case "3":
      return "focus-group-3";
    default:
      return null;
  }
}

interface ShortcutHandlers {
  onToggleSearch: () => void;
  onCycleTab: (direction: 1 | -1) => void;
  onToggleTerminal: () => void;
  onToggleFiles: () => void;
  onSplitTab: () => void;
  onNewConversation: () => void;
  onCloseTab: () => void;
  onToggleSidebar: () => void;
  onFocusGroup: (index: number) => void;
}

/** App-wide keyboard shortcuts: global search (Ctrl/Cmd+K, checked in the
 * original code by a separate always-on listener) plus everything
 * `matchShortcut` recognizes. Handlers are read through a ref updated every
 * render rather than listed as effect dependencies — none of them are
 * memoized by their owning hook, and the listener only needs to be attached
 * once for the app's lifetime, not re-attached whenever a handler identity
 * changes. Same pattern `AppShell` already uses for `sidebarHandlersRef`. */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    function handleSearchShortcut(event: KeyboardEvent): void {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        handlersRef.current.onToggleSearch();
      }
    }
    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const shortcut = matchShortcut(event);
      if (!shortcut) return;
      event.preventDefault();
      const current = handlersRef.current;
      switch (shortcut) {
        case "cycle-tab-next":
          current.onCycleTab(1);
          break;
        case "cycle-tab-prev":
          current.onCycleTab(-1);
          break;
        case "toggle-terminal":
          current.onToggleTerminal();
          break;
        case "toggle-files":
          current.onToggleFiles();
          break;
        case "split-tab":
          current.onSplitTab();
          break;
        case "new-conversation":
          current.onNewConversation();
          break;
        case "close-tab":
          current.onCloseTab();
          break;
        case "toggle-sidebar":
          current.onToggleSidebar();
          break;
        case "focus-group-1":
          current.onFocusGroup(0);
          break;
        case "focus-group-2":
          current.onFocusGroup(1);
          break;
        case "focus-group-3":
          current.onFocusGroup(2);
          break;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
