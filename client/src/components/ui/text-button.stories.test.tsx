import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stories from "./text-button.stories";

const { Default, Destructive, Icons, Matrix } = composeStories(stories);

describe("TextButton stories", () => {
  afterEach(cleanup);

  it("is a plain button with the muted tone by default", () => {
    render(<Default />);
    const button = screen.getByRole("button", { name: "Show all" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("data-tone", "muted");
  });

  it("forwards the tone", () => {
    render(<Destructive />);
    expect(screen.getByRole("button", { name: "Stop all" })).toHaveAttribute("data-tone", "destructive");
  });

  it("does not fire when disabled", async () => {
    const onClick = vi.fn();
    render(<Icons />);
    const previous = screen.getByRole("button", { name: "Previous question" });
    previous.onclick = onClick;
    await userEvent.click(previous);
    expect(previous).toBeDisabled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("covers every tone in the matrix", () => {
    render(<Matrix />);
    expect(screen.getAllByRole("button")).toHaveLength(stories.tones.length + 1);
  });
});
