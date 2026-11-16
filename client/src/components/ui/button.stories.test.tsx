import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stories from "./button.stories";

// The stories are the spec: each one renders here exactly as it does in the
// Storybook canvas, so a story that stops rendering what it claims fails CI
// instead of drifting unnoticed in a catalog nobody opened.
const { Default, Destructive, Disabled, IconOnly, AsChild, Matrix } = composeStories(stories);

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
    const perVariant = stories.textSizes.length + stories.iconSizes.length + 1;
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
