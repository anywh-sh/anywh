import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import * as stories from "./MediaViewer.stories";

const copy = en.chat.media.viewer;
const { Image, Gallery, Failed, Loading } = composeStories(stories);

describe("media viewer stories", () => {
  afterEach(() => act(() => cleanup()));

  it("Image shows one file with its caption and no counter, arrows or strip", async () => {
    render(<Image />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Sign in")).toBeInTheDocument();
    expect(within(dialog).queryByText(/ of /)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: copy.next })).not.toBeInTheDocument();
  });

  it("Image toggles between fitting the screen and its own pixels", async () => {
    render(<Image />);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: copy.actualSize }));
    expect(within(dialog).getByRole("button", { name: copy.fitToScreen })).toHaveAttribute("aria-pressed", "true");
  });

  it("Gallery steps with the arrows and the ← → keys, stopping at the ends", async () => {
    render(<Gallery />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("2 of 5")).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: copy.next }));
    expect(within(dialog).getByText("3 of 5")).toBeInTheDocument();

    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(within(dialog).getByText("1 of 5")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: copy.previous })).toBeDisabled();
  });

  it("Gallery jumps to a file from the strip", async () => {
    render(<Gallery />);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: en.chat.media.open.replace("{name}", "usage-chart.png") }));
    expect(within(dialog).getByText("5 of 5")).toBeInTheDocument();
    expect(within(dialog).getByText("Requests per day")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: copy.next })).toBeDisabled();
  });

  it("Gallery closes on Escape", async () => {
    render(<Gallery />);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open the viewer" })).toBeInTheDocument();
  });

  it("Failed says the file couldn't be loaded, and which one", async () => {
    render(<Failed />);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(copy.failed)).toBeInTheDocument();
    expect(within(dialog).getByText("/tmp/sim/gone.png")).toBeInTheDocument();
  });

  it("Loading shows progress until the file arrives", async () => {
    render(<Loading />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("status", { name: copy.title })).toBeInTheDocument();
  });
});
