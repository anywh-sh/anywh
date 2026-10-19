import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodeBlock, MAX_DISPLAY_CHARS, toDisplayText } from "@/components/chat/activity/CodeBlock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("toDisplayText", () => {
  it("pretty-prints objects and strings that parse as JSON, and leaves anything else alone", () => {
    expect(toDisplayText({ a: 1 })).toEqual({ text: '{\n  "a": 1\n}', json: true });
    expect(toDisplayText('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true });
    expect(toDisplayText("not { json")).toEqual({ text: "not { json", json: false });
    expect(toDisplayText("plain")).toEqual({ text: "plain", json: false });
  });

  it("survives a value JSON cannot hold", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(toDisplayText(loop).json).toBe(false);
    expect(toDisplayText(undefined).text).toBe("undefined");
  });
});

describe("CodeBlock", () => {
  const props = { label: "Arguments", copyLabel: "Copy arguments", onCopy: () => {} };

  it("copies the text as shown, and says so for a moment", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    render(<CodeBlock {...props} value={{ query: "x" }} onCopy={onCopy} />);
    await user.click(screen.getByRole("button", { name: "Copy arguments" }));
    expect(onCopy).toHaveBeenCalledWith('{\n  "query": "x"\n}');
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("cuts a huge payload for display, says how much, and still copies all of it", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    const huge = "a".repeat(MAX_DISPLAY_CHARS + 1234);
    const { container } = render(<CodeBlock {...props} value={huge} onCopy={onCopy} />);
    expect(container.querySelector("code")?.textContent).toHaveLength(MAX_DISPLAY_CHARS);
    expect(screen.getByText(/1,234 more characters/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy arguments" }));
    expect((onCopy.mock.calls[0] as [string])[0]).toHaveLength(MAX_DISPLAY_CHARS + 1234);
  });

  it("shows nothing about truncation for a payload that fits", () => {
    render(<CodeBlock {...props} value="short" />);
    expect(screen.queryByText(/more characters/)).toBeNull();
  });

  it("offers 'Show all' only past the height cap, and toggles", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CodeBlock {...props} value="one line" />);
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();

    // happy-dom has no layout, so a tall block is simulated by the measurement the component reads.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
    rerender(<CodeBlock {...props} value="a much taller block now" />);
    const toggle = await screen.findByRole("button", { name: "Show all" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  });
});
