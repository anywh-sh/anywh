import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./sonner.stories";

const { Default, Types } = composeStories(stories);

describe("Toaster stories", () => {
  afterEach(() => {
    act(() => cleanup());
  });

  it("portals its region to document.body and shows the toast", async () => {
    const { container } = render(<Default />);
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
    const region = document.body.querySelector("[data-sonner-toaster]");
    expect(region).not.toBeNull();
    expect(container.contains(region)).toBe(false);
  });

  it("stacks every type with only the newest in front", async () => {
    render(<Types />);
    await waitFor(() => expect(document.body.querySelectorAll("[data-sonner-toast]")).toHaveLength(5));
    expect(document.body.querySelectorAll('[data-sonner-toast][data-front="true"]')).toHaveLength(1);
  });
});
