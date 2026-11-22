import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./BotSettingsView.stories";
import { storyBotView } from "@/components/bots/botStoryData";
import { en } from "@/i18n/en";

const copy = en.bots.settings;
const { WhoItIs, EmptyMemory } = composeStories(stories);

describe("Bot settings tab stories", () => {
  afterEach(() => act(() => cleanup()));

  it("opens on who it is: its name and soul, with saving off until something changes", () => {
    render(<WhoItIs />);
    const view = screen.getByTestId("bot-settings-view");
    expect(within(view).getByRole("heading", { level: 1, name: storyBotView.name })).toBeInTheDocument();
    expect(within(view).getByDisplayValue(storyBotView.name)).toBeInTheDocument();
    for (const save of within(view).getAllByRole("button", { name: copy.save })) expect(save).toBeDisabled();
    expect(within(view).getByRole("button", { name: storyBotView.paused ? copy.resume : copy.pause })).toBeInTheDocument();
  });

  it("the sections switch the page: memory lists each line with its kind and count, and the last one pauses or deletes", async () => {
    render(<WhoItIs />);
    await userEvent.click(screen.getByRole("button", { name: `${copy.memory} 3` }));
    expect(screen.getByRole("heading", { level: 2, name: copy.memory })).toBeInTheDocument();
    expect(screen.getByText("Retry a test at most twice.")).toBeInTheDocument();
    expect(screen.getByText(copy.kinds.rule)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: copy.pauseOrDelete }));
    expect(screen.getByRole("button", { name: copy.delete })).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("an empty memory says the bot learns from the conversation", async () => {
    render(<EmptyMemory />);
    await userEvent.click(screen.getByRole("button", { name: copy.memory }));
    expect(screen.getByText(copy.memoryEmpty)).toBeInTheDocument();
  });
});
