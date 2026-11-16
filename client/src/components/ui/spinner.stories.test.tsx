import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./spinner.stories";

const { Default, Labelled, Matrix } = composeStories(stories);

describe("Spinner stories", () => {
  afterEach(cleanup);

  it("is hidden from the accessibility tree by default", () => {
    const { container } = render(<Default />);
    const spinner = container.querySelector('[data-slot="spinner"]');
    expect(spinner).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("becomes a named status when given a label", () => {
    render(<Labelled />);
    const status = screen.getByRole("status", { name: "Loading sessions" });
    expect(status).not.toHaveAttribute("aria-hidden");
    expect(status).toHaveAttribute("data-size", "md");
  });

  it("covers every tone at every size in the matrix", () => {
    render(<Matrix />);
    for (const tone of stories.tones) {
      for (const size of stories.sizes) {
        expect(document.querySelector(`[data-tone="${tone}"][data-size="${size}"]`), `${tone}/${size}`).not.toBeNull();
      }
    }
  });
});
