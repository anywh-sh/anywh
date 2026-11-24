import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./BotPaneToggleButton.stories";
import { en } from "@/i18n/en";

const { Closed, NeedsYou, OpenNeedsYou } = composeStories(stories);

describe("Bot pane toggle stories", () => {
  afterEach(() => act(() => cleanup()));

  it("Closed has no dot", () => {
    render(<Closed />);
    expect(screen.getByRole("button", { name: en.bots.panel.open })).toBeInTheDocument();
    expect(screen.queryByTestId("bot-pane-attention")).not.toBeInTheDocument();
  });

  it("NeedsYou marks the icon and says so, open or closed", () => {
    render(<NeedsYou />);
    expect(screen.getByTestId("bot-pane-attention")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${en.bots.panel.open} · ${en.bots.task.status.needs_you}` })).toBeInTheDocument();
    cleanup();
    render(<OpenNeedsYou />);
    expect(screen.getByTestId("bot-pane-attention")).toBeInTheDocument();
  });
});
