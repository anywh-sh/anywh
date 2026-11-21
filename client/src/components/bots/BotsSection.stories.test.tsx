import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./BotsSection.stories";
import { en } from "@/i18n/en";
import { resetBotsStore } from "@/lib/bots/botsStore";

const { States, Empty } = composeStories(stories);

describe("Bots sidebar section stories", () => {
  afterEach(() => {
    act(() => cleanup());
    resetBotsStore();
  });

  it("States draws one row per bot with what is going on", () => {
    render(<States />);
    expect(screen.getByRole("button", { name: "Vigia" })).toHaveTextContent("1 needs you · 2 working");
    expect(screen.getByRole("button", { name: "Faxina" })).toHaveTextContent(en.bots.status.paused);
    expect(screen.getByRole("button", { name: "Docs" })).toHaveTextContent(en.bots.status.failed);
    expect(screen.getByRole("button", { name: "Triagem" })).toHaveTextContent(en.bots.status.setup);
  });

  it("Empty invites the first bot", () => {
    render(<Empty />);
    expect(screen.getByRole("button", { name: en.bots.emptyCta })).toBeInTheDocument();
  });
});
