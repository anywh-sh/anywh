import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("Empty is a card with one line and the two ways in", async () => {
    const onNewBot = vi.fn();
    render(<Empty onNewBot={onNewBot} />);
    const card = screen.getByTestId("bots-first-card");
    expect(within(card).getByText(en.bots.firstBot.title)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: en.bots.firstBot.create }));
    expect(onNewBot).toHaveBeenLastCalledWith();
    await userEvent.click(within(card).getByRole("button", { name: en.bots.firstBot.templates }));
    expect(onNewBot).toHaveBeenLastCalledWith("templates");
  });

});
