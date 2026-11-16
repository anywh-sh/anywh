import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stories from "./button.stories";

// The stories are the spec: each one renders here exactly as it does in the
// Storybook canvas, so a story that stops rendering what it claims fails CI
// instead of drifting unnoticed in a catalog nobody opened.
const { Default, Destructive, Disabled, Loading, IconOnly, AsChild, Matrix } = composeStories(stories);

describe("Button stories", () => {
  afterEach(cleanup);

  it("renders the default variant and size", () => {
    render(<Default />);
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button).toHaveAttribute("data-variant", "default");
    expect(button).toHaveAttribute("data-size", "default");
  });

  it("forwards the variant", () => {
    render(<Destructive />);
    expect(screen.getByRole("button", { name: "Delete session" })).toHaveAttribute("data-variant", "destructive");
  });

  it("does not fire onClick when disabled", async () => {
    const onClick = vi.fn();
    render(<Disabled onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is busy, disabled and keeps its label while loading", async () => {
    const onClick = vi.fn();
    render(<Loading onClick={onClick} />);
    // The label stays in the tree (hidden, holding the width) and still
    // names the button.
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector('[data-slot="spinner"]')).toHaveAttribute("data-tone", "current");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("sizes the spinner to the button", () => {
    render(<Loading size="xs" />);
    expect(screen.getByRole("button").querySelector('[data-slot="spinner"]')).toHaveAttribute("data-size", "xs");
  });

  it("renders no spinner when idle", () => {
    render(<Default />);
    const button = screen.getByRole("button");
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it("keeps an accessible name when the label is only an icon", () => {
    render(<IconOnly />);
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("data-size", "icon");
  });

  it("renders the child element instead of a button with asChild", () => {
    render(<AsChild />);
    const link = screen.getByRole("link", { name: "anywh.sh" });
    expect(link).toHaveAttribute("data-slot", "button");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("covers every variant at every size in the matrix", () => {
    render(<Matrix />);
    // Every size, plus one disabled and one loading.
    const perVariant = stories.textSizes.length + stories.iconSizes.length + 2;
    expect(screen.getAllByRole("button")).toHaveLength(stories.variants.length * perVariant);
    for (const variant of stories.variants) {
      for (const size of [...stories.textSizes, ...stories.iconSizes]) {
        expect(
          document.querySelector(`[data-variant="${variant}"][data-size="${size}"]`),
          `${variant}/${size}`,
        ).not.toBeNull();
      }
    }
  });
});
