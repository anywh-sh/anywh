import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./BotPanel.stories";
import { en } from "@/i18n/en";

const copy = en.bots;
const { Tasks, Empty, Question, Working, ConversationWaits } = composeStories(stories);

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
});
