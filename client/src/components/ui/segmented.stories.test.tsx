import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./segmented.stories";

const { Tabs, Radio } = composeStories(stories);

describe("Segmented stories", () => {
  afterEach(cleanup);

  it("is a tablist by default", () => {
    render(<Tabs />);
    expect(screen.getByRole("tablist", { name: "Check for updates" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Notify" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("is a radiogroup for a value", async () => {
    render(<Radio />);
    expect(screen.getByRole("radiogroup", { name: "Check for updates" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Never" }));
    expect(screen.getByRole("radio", { name: "Never" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Notify" })).toHaveAttribute("aria-checked", "false");
  });

  it("moves and selects with the arrow keys, either way", async () => {
    render(<Radio />);
    screen.getByRole("radio", { name: "Notify" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Never" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Never" })).toHaveAttribute("aria-checked", "true");
  });

  it("puts only the chosen option in the Tab order", () => {
    render(<Tabs />);
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });
});
