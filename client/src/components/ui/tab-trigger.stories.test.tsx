import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./tab-trigger.stories";

const { Default, Closable } = composeStories(stories);

describe("TabTrigger stories", () => {
  afterEach(cleanup);

  it("puts only the selected tab in the Tab order", () => {
    render(<Default />);
    const [first, second] = screen.getAllByRole("tab");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveAttribute("data-state", "active");
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("aria-selected", "false");
    expect(second).toHaveAttribute("tabindex", "-1");
  });

  it("selects on click", async () => {
    render(<Default />);
    await userEvent.click(screen.getByRole("tab", { name: "Terminal 2" }));
    expect(screen.getByRole("tab", { name: "Terminal 2" })).toHaveAttribute("aria-selected", "true");
  });

  it("moves and selects with the arrow keys", async () => {
    render(<Default />);
    screen.getByRole("tab", { name: "Terminal 1" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Terminal 2" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Terminal 2" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the × out of the tab, as its own button", () => {
    render(<Closable />);
    const close = screen.getByRole("button", { name: "Close Terminal 1" });
    expect(screen.getByRole("tab", { name: "Terminal 1" })).not.toContainElement(close);
  });
});
