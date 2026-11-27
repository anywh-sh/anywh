import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./dialog.stories";

const { Default, Large } = composeStories(stories);

describe("Dialog stories", () => {
  afterEach(() => act(() => cleanup()));

  it("opens every size, saying which on the frame", async () => {
    for (const size of stories.sizes) {
      render(<Default size={size} />);
      expect(await screen.findByRole("dialog")).toHaveAttribute("data-size", size);
      act(() => cleanup());
    }
  });

  it("Default is a form: the title names the dialog, and Escape closes it", async () => {
    render(<Default />);
    const dialog = await screen.findByRole("dialog", { name: "Rename session" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open the dialog" })).toBeInTheDocument();
  });

  it("Large holds its content edge to edge under the band", async () => {
    render(<Large />);
    const dialog = await screen.findByRole("dialog", { name: "Requests per day" });
    expect(dialog).toHaveAttribute("data-size", "large");
    expect(within(dialog).getByRole("img", { name: "Requests per day" })).toBeInTheDocument();
  });
});
