import { afterEach, describe, expect, it, vi } from "vitest";
import { openTerminalLink, shouldActivateTerminalLink } from "@/lib/terminal/terminalLinks";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => {
    openUrl(...args);
  },
}));

function click(mods: { ctrlKey?: boolean; metaKey?: boolean } = {}): Parameters<typeof openTerminalLink>[0] {
  return { ctrlKey: false, metaKey: false, ...mods };
}

/** `isMacOS()` sniffs the UA, so that's the knob for the platform branch. */
function pretendMacOS(): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
  );
}

afterEach(() => {
  openUrl.mockClear();
  vi.restoreAllMocks();
});

describe("shouldActivateTerminalLink", () => {
  it("takes Ctrl off macOS and Cmd on macOS", () => {
    expect(shouldActivateTerminalLink(click({ ctrlKey: true }), false)).toBe(true);
    expect(shouldActivateTerminalLink(click({ metaKey: true }), true)).toBe(true);
  });

  it("does not cross the modifiers over", () => {
    expect(shouldActivateTerminalLink(click({ metaKey: true }), false)).toBe(false);
    expect(shouldActivateTerminalLink(click({ ctrlKey: true }), true)).toBe(false);
  });

  it("ignores a bare click — the pointer is a selection tool in a terminal", () => {
    expect(shouldActivateTerminalLink(click(), false)).toBe(false);
    expect(shouldActivateTerminalLink(click(), true)).toBe(false);
  });
});

describe("openTerminalLink", () => {
  it("hands the URL to the opener plugin on Ctrl+click", () => {
    openTerminalLink(click({ ctrlKey: true }), "https://example.test/x");
    expect(openUrl).toHaveBeenCalledWith("https://example.test/x");
  });

  it("opens nothing on a bare click", () => {
    openTerminalLink(click(), "https://example.test/x");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("wants Cmd, not Ctrl, on macOS", () => {
    pretendMacOS();
    openTerminalLink(click({ ctrlKey: true }), "https://example.test/x");
    expect(openUrl).not.toHaveBeenCalled();
    openTerminalLink(click({ metaKey: true }), "https://example.test/x");
    expect(openUrl).toHaveBeenCalledWith("https://example.test/x");
  });
});
