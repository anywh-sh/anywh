import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./BotPanel.stories";
import { en } from "@/i18n/en";

const copy = en.bots;
const { Tasks, Empty, Question, Working, HandedOff, HandedOffSenderGone, ConversationWaits, Settings, SettingsEmptyMemory } = composeStories(stories);

describe("Bot panel stories", () => {
  afterEach(() => act(() => cleanup()));

  it("Tasks groups by status with what needs the person first, closed ones folded", () => {
    render(<Tasks />);
    const headings = screen.getAllByRole("button", { expanded: true }).map((button) => button.textContent ?? "");
    expect(headings[0]).toContain(copy.panel.groups.needs_you);
    expect(screen.getByRole("button", { name: new RegExp(copy.panel.groups.done) })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Move the CI cache")).not.toBeInTheDocument();
    expect(screen.getByText("Fix the flaky relay test")).toBeInTheDocument();
    const schedules = screen.getAllByTestId("bot-schedule");
    expect(schedules).toHaveLength(2);
    expect(within(schedules[1]).getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("a handed-over task names the bot it came from, or says that bot is gone", () => {
    render(<HandedOff />);
    expect(screen.getByTestId("bot-task-from")).toHaveTextContent(copy.task.from.replace("{name}", "Release"));
    cleanup();
    render(<HandedOffSenderGone />);
    expect(screen.getByTestId("bot-task-from")).toHaveTextContent(copy.task.fromGone);
    cleanup();
    render(<Working />);
    expect(screen.queryByTestId("bot-task-from")).not.toBeInTheDocument();
  });

  it("opening a task shows it in place, and back returns to the list", async () => {
    render(<Tasks />);
    await userEvent.click(screen.getByText("Fix the flaky relay test"));
    expect(screen.getByTestId("bot-task-detail")).toBeInTheDocument();
    expect(screen.getByText(/20 times in a row/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: copy.task.back }));
    expect(screen.queryByTestId("bot-task-detail")).not.toBeInTheDocument();
  });

  it("Question offers the options with the recommended one marked; Working lists its agent and history", () => {
    render(<Question />);
    expect(screen.getByText("Retry per test or the whole job?")).toBeInTheDocument();
    expect(screen.getByText(copy.task.recommended)).toBeInTheDocument();
    cleanup();
    render(<Working />);
    expect(screen.getByText(copy.task.doneMeans)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fix flaky test/ })).toBeInTheDocument();
    expect(screen.getByText("The test reconnects before the relay saves the session")).toBeInTheDocument();
  });

  it("Empty says what will show up, and ConversationWaits says the conversation is waiting", () => {
    render(<Empty />);
    expect(screen.getByText(copy.panel.noTasks)).toBeInTheDocument();
    expect(screen.getByText(copy.panel.noAutomations.replace("{name}", "Triagem"))).toBeInTheDocument();
    cleanup();
    render(<ConversationWaits />);
    expect(screen.getByText(copy.panel.conversationNeedsYou)).toBeInTheDocument();
  });

  it("the gear opens the settings in place of the tasks, and Tasks comes back", async () => {
    render(<Tasks />);
    await userEvent.click(screen.getByRole("button", { name: copy.menu.settings }));
    const settings = screen.getByTestId("bot-settings");
    expect(within(settings).getByRole("heading", { name: copy.settings.nameAndMascot })).toBeInTheDocument();
    expect(screen.queryAllByTestId("bot-schedule")).toHaveLength(0);
    await userEvent.click(within(settings).getByRole("button", { name: copy.task.back }));
    expect(screen.queryByTestId("bot-settings")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("bot-schedule")).toHaveLength(2);
  });

  it("Settings shows the name and face, who it is, the memory with its count and kinds, and pause or delete", () => {
    render(<Settings />);
    const settings = screen.getByTestId("bot-settings");
    expect(within(settings).getByDisplayValue("Vigia")).toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: `${copy.mascot.characters.bip} · ${copy.mascot.tones.sand} · ${copy.mascot.change}` })).toBeInTheDocument();
    for (const save of within(settings).getAllByRole("button", { name: copy.settings.save })) expect(save).toBeDisabled();
    expect(within(settings).getByRole("heading", { name: `${copy.settings.memory} 3` })).toBeInTheDocument();
    expect(within(settings).getByText(copy.settings.kinds.rule)).toBeInTheDocument();
    expect(within(settings).getByRole("switch", { name: copy.settings.pause })).toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: copy.settings.delete })).toBeInTheDocument();
  });

  it("an empty memory says the bot learns from the conversation", () => {
    render(<SettingsEmptyMemory />);
    expect(screen.getByText(copy.settings.memoryEmpty)).toBeInTheDocument();
  });
});
