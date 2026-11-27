import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import * as stories from "./MediaViewer.stories";

const copy = en.chat.media.viewer;
const { Image, Gallery, Wide, Failed, Loading } = composeStories(stories);

function header(dialog: HTMLElement): HTMLElement {
  return dialog.querySelector<HTMLElement>("[data-slot=dialog-header]")!;
}

function strip(dialog: HTMLElement): HTMLElement[] {
  return within(dialog).queryAllByRole("button", { name: /^Open / });
}

describe("media viewer stories", () => {
  afterEach(() => act(() => cleanup()));

  it("Image opens a large dialog named by the caption, with no counter, arrows or strip", async () => {
    render(<Image />);
    const dialog = await screen.findByRole("dialog", { name: "Sign in" });
    expect(dialog).toHaveAttribute("data-size", "large");
    // The file's own name next to a caption that isn't it.
    expect(within(header(dialog)).getByText("01-sign-in.png")).toBeInTheDocument();
    expect(within(dialog).queryByText(/ of /)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: copy.next })).not.toBeInTheDocument();
    expect(strip(dialog)).toEqual([]);
  });

  it("Image takes the focus on its frame, so the arrows work at once and no tooltip opens", async () => {
    render(<Image />);
    expect(await screen.findByRole("dialog")).toHaveFocus();
  });

  it("Image keeps its actions in the header band, before the close button", async () => {
    render(<Image />);
    const dialog = await screen.findByRole("dialog");
    const names = within(header(dialog))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([copy.actualSize, copy.copyPath, en.common.download, en.common.close]);
  });

  it("Image toggles between fitting the stage and its own pixels", async () => {
    render(<Image />);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: copy.actualSize }));
    expect(within(dialog).getByRole("button", { name: copy.fitToScreen })).toHaveAttribute("aria-pressed", "true");
  });

  it("Image copies the file's path", async () => {
    const user = userEvent.setup();
    render(<Image />);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: copy.copyPath }));
    expect(await within(dialog).findByRole("button", { name: copy.pathCopied })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe("/tmp/sim/01-sign-in.png");
  });

  it("Gallery steps with the arrows and the ← → keys, stopping at the ends", async () => {
    render(<Gallery />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("2 of 6")).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: copy.next }));
    expect(within(dialog).getByText("3 of 6")).toBeInTheDocument();

    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(within(dialog).getByText("1 of 6")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: copy.previous })).toBeDisabled();
  });

  it("Gallery brings the file it lands on in from the side it lies on", async () => {
    render(<Gallery />);
    const dialog = await screen.findByRole("dialog");
    // Opening is the dialog's own motion, not a step.
    expect(dialog.querySelector("[data-media-step]")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: copy.next }));
    expect(dialog.querySelector("[data-media-step]")).toHaveAttribute("data-media-step", "next");
    await userEvent.click(within(dialog).getByRole("button", { name: copy.previous }));
    expect(dialog.querySelector("[data-media-step]")).toHaveAttribute("data-media-step", "prev");
  });

  it("Gallery jumps to a file from the strip, which marks the one on show", async () => {
    render(<Gallery />);
    const dialog = await screen.findByRole("dialog");
    const chart = within(dialog).getByRole("button", { name: en.chat.media.open.replace("{name}", "usage-chart.png") });
    await userEvent.click(chart);
    expect(within(dialog).getByText("5 of 6")).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Requests per day" })).toBeInTheDocument();
    expect(strip(dialog).filter((thumb) => thumb.getAttribute("aria-pressed") === "true")).toEqual([chart]);
  });

  it("Gallery closes on Escape", async () => {
    render(<Gallery />);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open the viewer" })).toBeInTheDocument();
  });

  it("Wide fits one picture, with nothing to step to", async () => {
    render(<Wide />);
    const dialog = await screen.findByRole("dialog", { name: "Requests per day" });
    expect(within(dialog).getByRole("img", { name: "Requests per day" })).toBeInTheDocument();
    expect(strip(dialog)).toEqual([]);
  });

  it("Failed says the file couldn't be loaded, and which one, with nothing to zoom or download", async () => {
    render(<Failed />);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(copy.failed)).toBeInTheDocument();
    expect(within(dialog).getByText("/tmp/sim/gone.png")).toBeInTheDocument();
    // The header learns it from the stage a render later.
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: copy.actualSize })).not.toBeInTheDocument());
    expect(within(dialog).queryByRole("button", { name: en.common.download })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: copy.copyPath })).toBeInTheDocument();
  });

  it("Loading shows progress until the file arrives", async () => {
    render(<Loading />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("status", { name: en.common.loading })).toBeInTheDocument();
  });
});
