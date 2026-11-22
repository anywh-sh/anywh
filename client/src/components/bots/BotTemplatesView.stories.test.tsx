import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import * as stories from "./BotTemplatesView.stories";

const { Templates } = composeStories(stories);

describe("Bot templates stories", () => {
  afterEach(() => act(() => cleanup()));

  it("shows every template with its own face after From scratch, and a card picks its template", async () => {
    const onPick = vi.fn();
    render(<Templates onPick={onPick} />);
    expect(screen.getByText(en.bots.templatesTab.heading)).toBeInTheDocument();
    for (const id of ["ci-check", "pr-review", "issue-triage", "daily-summary", "backlog-cleanup"] as const) {
      expect(screen.getByTestId(`bot-template-${id}`)).toHaveTextContent(en.bots.templates[id].name);
    }
    expect(screen.getByTestId("bot-template-pr-review").querySelector("[data-mascot]")?.getAttribute("data-mascot")).toBe("oculos:giz");
    await userEvent.click(screen.getByTestId("bot-template-daily-summary"));
    expect(onPick).toHaveBeenLastCalledWith("daily-summary");
    await userEvent.click(screen.getByTestId("bot-template-scratch"));
    expect(onPick).toHaveBeenLastCalledWith();
  });
});
