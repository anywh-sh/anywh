import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./Mascot.stories";

const { Playground, Sheet, Tones, Sizes } = composeStories(stories);

describe("Mascot stories", () => {
  afterEach(() => act(() => cleanup()));

  it("Playground draws one path per color, on the 16-cell grid, never smoothed", () => {
    const { container } = render(<Playground />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
    const fills = [...container.querySelectorAll("path")].map((path) => path.getAttribute("fill"));
    expect(new Set(fills).size).toBe(fills.length);
  });

  it("Sheet marks what needs attention in the corner, nothing at rest or while setting up", () => {
    const { container } = render(<Sheet />);
    const badge = (state: string): string | null | undefined => container.querySelector(`[data-state="${state}"] [data-mascot-badge]`)?.getAttribute("data-mascot-badge");
    expect(badge("needsYou")).toBe("needsYou");
    expect(badge("failed")).toBe("failed");
    expect(badge("limit")).toBe("limit");
    expect(badge("idle")).toBeUndefined();
    expect(badge("setup")).toBeUndefined();
  });

  it("Tones names every face, and Sizes the sizes asked for", () => {
    render(<Tones />);
    expect(screen.getByRole("img", { name: "salvia" })).toBeInTheDocument();
    const { container } = render(<Sizes />);
    expect([...container.querySelectorAll("svg")].map((svg) => svg.getAttribute("width"))).toEqual(["16", "32", "48", "64", "96", "128"]);
  });
});
