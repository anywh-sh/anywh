import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eventTargetInTerminal,
  isTerminalOwnedShortcut,
  matchShortcut,
  useKeyboardShortcuts,
} from "@/hooks/useKeyboardShortcuts";

function key(
  k: string,
  mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
): Parameters<typeof matchShortcut>[0] {
  return { key: k, ctrlKey: false, metaKey: false, shiftKey: false, ...mods };
}

describe("matchShortcut", () => {
  it("Ctrl+Tab cycles forward, Ctrl+Shift+Tab cycles backward", () => {
    expect(matchShortcut(key("Tab", { ctrlKey: true }))).toBe("cycle-tab-next");
    expect(matchShortcut(key("Tab", { ctrlKey: true, shiftKey: true }))).toBe("cycle-tab-prev");
  });

  it("Cmd+Tab (no Ctrl) is not a shortcut — that's the OS app switcher on macOS", () => {
    expect(matchShortcut(key("Tab", { metaKey: true }))).toBeNull();
  });

  it("literal Ctrl+backtick toggles the terminal, even with metaKey also held", () => {
    expect(matchShortcut(key("`", { ctrlKey: true }))).toBe("toggle-terminal");
    expect(matchShortcut(key("`", { ctrlKey: true, metaKey: true }))).toBe("toggle-terminal");
  });

  it("Cmd+backtick (no Ctrl) is not a shortcut — that's macOS's own window switcher", () => {
    expect(matchShortcut(key("`", { metaKey: true }))).toBeNull();
  });

  it("Ctrl+Shift+E opens the files panel", () => {
    expect(matchShortcut(key("e", { ctrlKey: true, shiftKey: true }))).toBe("toggle-files");
    expect(matchShortcut(key("E", { ctrlKey: true, shiftKey: true }))).toBe("toggle-files");
  });

  it("Ctrl+E alone (no Shift) is not a shortcut", () => {
    expect(matchShortcut(key("e", { ctrlKey: true }))).toBeNull();
  });

  it("Ctrl+backslash splits the active tab", () => {
    expect(matchShortcut(key("\\", { ctrlKey: true }))).toBe("split-tab");
  });

  it.each([
    ["n", "new-conversation"],
    ["w", "close-tab"],
    ["b", "toggle-sidebar"],
    ["1", "focus-group-1"],
    ["2", "focus-group-2"],
    ["3", "focus-group-3"],
  ] as const)("Cmd/Ctrl+%s maps to %s, from either modifier", (letter, expected) => {
    expect(matchShortcut(key(letter, { ctrlKey: true }))).toBe(expected);
    expect(matchShortcut(key(letter, { metaKey: true }))).toBe(expected);
    expect(matchShortcut(key(letter.toUpperCase(), { ctrlKey: true }))).toBe(expected);
  });

  it("plain letters with no modifier are never a shortcut", () => {
    expect(matchShortcut(key("n"))).toBeNull();
    expect(matchShortcut(key("1"))).toBeNull();
  });

  it("an unmapped letter with a modifier held falls through to null", () => {
    expect(matchShortcut(key("x", { ctrlKey: true }))).toBeNull();
    expect(matchShortcut(key("4", { metaKey: true }))).toBeNull();
  });
});

describe("isTerminalOwnedShortcut", () => {
  it.each(["w", "k", "b", "n", "1", "\\"])("plain Ctrl+%s belongs to the shell", (k) => {
    expect(isTerminalOwnedShortcut(key(k, { ctrlKey: true }))).toBe(true);
  });

  it("leaves the app the combinations xterm emits nothing for", () => {
    expect(isTerminalOwnedShortcut(key("Tab", { ctrlKey: true }))).toBe(false);
    expect(isTerminalOwnedShortcut(key("`", { ctrlKey: true }))).toBe(false);
    expect(isTerminalOwnedShortcut(key("e", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("never claims a Cmd shortcut — on macOS the app owns Cmd, the shell owns Ctrl", () => {
    expect(isTerminalOwnedShortcut(key("w", { metaKey: true }))).toBe(false);
    expect(isTerminalOwnedShortcut(key("w", { ctrlKey: true, metaKey: true }))).toBe(false);
  });

  it("ignores a key with no modifier at all", () => {
    expect(isTerminalOwnedShortcut(key("w"))).toBe(false);
  });
});

describe("eventTargetInTerminal", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("recognizes a descendant of the xterm container, not just the container", () => {
    document.body.innerHTML = `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`;
    expect(eventTargetInTerminal(document.querySelector(".xterm-helper-textarea"))).toBe(true);
    expect(eventTargetInTerminal(document.querySelector(".xterm"))).toBe(true);
  });

  it("is false for anything outside it, including a null target", () => {
    document.body.innerHTML = `<input id="composer" />`;
    expect(eventTargetInTerminal(document.querySelector("#composer"))).toBe(false);
    expect(eventTargetInTerminal(null)).toBe(false);
  });
});

describe("useKeyboardShortcuts with the terminal focused", () => {
  function handlers(): Parameters<typeof useKeyboardShortcuts>[0] {
    return {
      onToggleSearch: vi.fn(),
      onCycleTab: vi.fn(),
      onToggleTerminal: vi.fn(),
      onToggleFiles: vi.fn(),
      onSplitTab: vi.fn(),
      onNewConversation: vi.fn(),
      onCloseTab: vi.fn(),
      onToggleSidebar: vi.fn(),
      onFocusGroup: vi.fn(),
    };
  }

  function pressFrom(selector: string, init: KeyboardEventInit): void {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`no element matched ${selector}`);
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not close the tab or open search on Ctrl+W / Ctrl+K raised inside the terminal", () => {
    document.body.innerHTML = `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`;
    const spies = handlers();
    renderHook(() => { useKeyboardShortcuts(spies); });

    pressFrom(".xterm-helper-textarea", { key: "w", ctrlKey: true });
    pressFrom(".xterm-helper-textarea", { key: "k", ctrlKey: true });

    expect(spies.onCloseTab).not.toHaveBeenCalled();
    expect(spies.onToggleSearch).not.toHaveBeenCalled();
  });

  it("still toggles the panel on Ctrl+backtick — the way out from inside the terminal", () => {
    document.body.innerHTML = `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`;
    const spies = handlers();
    renderHook(() => { useKeyboardShortcuts(spies); });

    pressFrom(".xterm-helper-textarea", { key: "`", ctrlKey: true });

    expect(spies.onToggleTerminal).toHaveBeenCalledOnce();
  });

  it("leaves the same shortcuts working everywhere else", () => {
    document.body.innerHTML = `<input id="composer" />`;
    const spies = handlers();
    renderHook(() => { useKeyboardShortcuts(spies); });

    pressFrom("#composer", { key: "w", ctrlKey: true });

    expect(spies.onCloseTab).toHaveBeenCalledOnce();
  });
});
