import { afterEach, describe, expect, it, vi } from "vitest";
import { modifierKeyLabel, shiftKeyLabel, shortcutKeys, shortcutLabel } from "@/lib/platform/platform";

const asUserAgent = (ua: string): void => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
};

afterEach(() => vi.restoreAllMocks());

describe("keycap labels", () => {
  it("writes the keys with macOS's symbols on a Mac", () => {
    asUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15");
    expect(modifierKeyLabel()).toBe("⌘");
    expect(shiftKeyLabel()).toBe("⇧");
    expect(shortcutKeys("K")).toEqual(["⌘", "K"]);
    expect(shortcutLabel("K")).toBe("⌘K");
  });

  it("writes them as words on Windows and Linux", () => {
    for (const ua of ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Mozilla/5.0 (X11; Linux x86_64)"]) {
      asUserAgent(ua);
      expect(modifierKeyLabel()).toBe("Ctrl");
      expect(shiftKeyLabel()).toBe("Shift");
      expect(shortcutKeys("K")).toEqual(["Ctrl", "K"]);
    }
  });
});
