import { describe, expect, it } from "vitest";
import { matchShortcut } from "@/hooks/useKeyboardShortcuts";

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
