import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

  it("Large plays its entrance only once it has been painted, and Default never waits", async () => {
    render(<Large />);
    const large = await screen.findByRole("dialog");
    await waitFor(() => expect(large).toHaveAttribute("data-entered"));
    act(() => cleanup());

    render(<Default />);
    const small = await screen.findByRole("dialog");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(small).not.toHaveAttribute("data-entered");
  });

  it("Default is a form: the title names the dialog, and Escape closes it", async () => {
    render(<Default />);
    const dialog = await screen.findByRole("dialog", { name: "Rename session" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open the dialog" })).toBeInTheDocument();
  });

  it("Large lays its actions in the header band, just before the close button", async () => {
    render(<Large />);
    const dialog = await screen.findByRole("dialog", { name: "Requests per day" });
    const band = dialog.querySelector<HTMLElement>("[data-slot=dialog-header]")!;
    const names = within(band)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["Copy path", "Download", "Close"]);
    expect(within(dialog).getByRole("img", { name: "Requests per day" })).toBeInTheDocument();
  });
});
