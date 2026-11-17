import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stories from "./row-button.stories";

const { Default, Selected, Faint, Rail, Disabled, Matrix } = composeStories(stories);

describe("RowButton stories", () => {
  afterEach(cleanup);

  it("is a plain button, never a submit", () => {
    render(<Default />);
    const row = screen.getByRole("button", { name: "Search" });
    expect(row).toHaveAttribute("type", "button");
    expect(row).toHaveAttribute("data-tone", "default");
    expect(row).not.toHaveAttribute("data-selected");
  });

  it("marks the selected row on the edge it is given", () => {
    render(<Selected />);
    const row = screen.getByRole("button", { name: "New conversation" });
    expect(row).toHaveAttribute("data-selected", "true");
    expect(row.querySelector('[data-slot="row-button-mark"]')).toHaveClass("left-0");
  });

  it("draws the mark on the far edge for the rail", () => {
    render(<Rail />);
    expect(screen.getByRole("button", { name: "Close terminal" }).querySelector('[data-slot="row-button-mark"]')).toHaveClass("right-0");
  });

  it("draws no mark when the row is not selected", () => {
    render(<Default mark="start" />);
    expect(screen.getByRole("button").querySelector('[data-slot="row-button-mark"]')).toBeNull();
  });

  it("gives the faint tone no fill on hover", () => {
    render(<Faint />);
    expect(screen.getByRole("button")).not.toHaveClass("hover:bg-bg-hover");
    cleanup();
    render(<Default />);
    expect(screen.getByRole("button")).toHaveClass("hover:bg-bg-hover");
  });

  it("does not fire onClick when disabled", async () => {
    const onClick = vi.fn();
    render(<Disabled onClick={onClick} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("covers every tone at every size in the matrix", () => {
    render(<Matrix />);
    expect(screen.getAllByRole("button")).toHaveLength(stories.tones.length * stories.sizes.length * 2);
  });
});
