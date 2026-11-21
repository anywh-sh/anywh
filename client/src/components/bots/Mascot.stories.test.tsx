import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./Mascot.stories";

const { Playground, States, Names, Sizes } = composeStories(stories);

describe("Mascot stories", () => {
  afterEach(() => act(() => cleanup()));

  it("Playground draws square cells only", () => {
    const { container } = render(<Playground />);
    const rects = container.querySelectorAll("rect");
    expect(rects.length).toBeGreaterThan(20);
    for (const rect of rects) expect(rect.getAttribute("width")).toBe("1");
  });

  it("States draws a badge for what needs attention, none at rest or while setting up", () => {
    const { container } = render(<States />);
    const badged = (state: string): boolean => container.querySelector(`[data-state="${state}"] [data-mascot-state="${state}"] span`) !== null;
    expect(badged("needsYou")).toBe(true);
    expect(badged("failed")).toBe(true);
    expect(badged("idle")).toBe(false);
    expect(badged("setup")).toBe(false);
  });

  it("Names gives every face its name as a label, and Sizes the sizes asked for", () => {
    render(<Names />);
    expect(screen.getByRole("img", { name: "Vigia" })).toBeInTheDocument();
    const { container } = render(<Sizes />);
    expect([...container.querySelectorAll("svg")].map((svg) => svg.getAttribute("width"))).toEqual(["12", "24", "36", "48", "96"]);
  });
});
