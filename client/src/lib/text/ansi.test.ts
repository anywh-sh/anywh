import { describe, expect, it } from "vitest";
import { stripAnsi } from "./ansi";

describe("stripAnsi", () => {
  it("leaves text with no escapes alone", () => {
    expect(stripAnsi("Waiting for authorization… (^C to cancel)")).toBe("Waiting for authorization… (^C to cancel)");
  });

  it("removes color and cursor sequences", () => {
    expect(stripAnsi("[94mhttps://example.test[39m")).toBe("https://example.test");
    expect(stripAnsi("[1G[0JOr paste the redirect URL here: ")).toBe("Or paste the redirect URL here: ");
  });

  it("removes the hyperlink wrapper, which otherwise prints the URL twice", () => {
    // Verbatim shape from a real `claude mcp login --no-browser` run: the
    // OSC 8 sequence carries the URL invisibly, and the same URL follows
    // as the link's visible text.
    const real = "  ]8;;https://mcp.example.dev/oauth/authorize?state=abc[94mhttps://mcp.example.dev/oauth/authorize?state=abc[39m]8;;";
    expect(stripAnsi(real)).toBe("  https://mcp.example.dev/oauth/authorize?state=abc");
  });

  it("handles the string-terminator form of an OSC sequence too", () => {
    expect(stripAnsi("a]0;window title\\b")).toBe("ab");
  });

  it("keeps carriage returns, which a CLI uses to redraw a line it wrote", () => {
    expect(stripAnsi("first\r\nsecond")).toBe("first\r\nsecond");
  });
});
