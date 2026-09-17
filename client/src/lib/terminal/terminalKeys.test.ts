import { describe, expect, it } from "vitest";
import { isNativePasteShortcut, shouldCopySelection } from "@/lib/terminal/terminalKeys";

function key(
  k: string,
  mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
): Parameters<typeof isNativePasteShortcut>[0] {
  return { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods };
}

describe("isNativePasteShortcut", () => {
  it("matches plain Ctrl+V, in either case", () => {
    expect(isNativePasteShortcut(key("v", { ctrlKey: true }))).toBe(true);
    expect(isNativePasteShortcut(key("V", { ctrlKey: true }))).toBe(true);
  });

  it("leaves Ctrl+Shift+V alone — that path already pastes natively", () => {
    expect(isNativePasteShortcut(key("v", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("leaves Cmd+V alone — macOS doesn't go through ctrlKey", () => {
    expect(isNativePasteShortcut(key("v", { metaKey: true }))).toBe(false);
  });

  it("ignores V without Ctrl", () => {
    expect(isNativePasteShortcut(key("v"))).toBe(false);
  });
});

describe("shouldCopySelection", () => {
  it("copies on Ctrl+C when there is a selection", () => {
    expect(shouldCopySelection(key("c", { ctrlKey: true }), true, false)).toBe(true);
    expect(shouldCopySelection(key("C", { ctrlKey: true }), true, false)).toBe(true);
  });

  it("does not copy without a selection — that is the SIGINT path, untouched", () => {
    expect(shouldCopySelection(key("c", { ctrlKey: true }), false, false)).toBe(false);
  });

  it("never copies on macOS: Cmd+C already does, and Ctrl+C has to stay SIGINT", () => {
    expect(shouldCopySelection(key("c", { ctrlKey: true }), true, true)).toBe(false);
    expect(shouldCopySelection(key("c", { metaKey: true }), true, true)).toBe(false);
  });

  it("ignores Ctrl+C carrying another modifier", () => {
    expect(shouldCopySelection(key("c", { ctrlKey: true, shiftKey: true }), true, false)).toBe(false);
    expect(shouldCopySelection(key("c", { ctrlKey: true, altKey: true }), true, false)).toBe(false);
    expect(shouldCopySelection(key("c", { ctrlKey: true, metaKey: true }), true, false)).toBe(false);
  });

  it("ignores any other key, selection or not", () => {
    expect(shouldCopySelection(key("d", { ctrlKey: true }), true, false)).toBe(false);
    expect(shouldCopySelection(key("c"), true, false)).toBe(false);
  });
});
