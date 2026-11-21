import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./NewBotDialog.stories";
import { en } from "@/i18n/en";

const copy = en.bots;
const { Templates } = composeStories(stories);

describe("New bot dialog stories", () => {
  afterEach(() => act(() => cleanup()));

  it("lists the five templates and previews the one picked", async () => {
    render(<Templates />);
    const dialog = await screen.findByTestId("new-bot-dialog");
    for (const id of ["ci-check", "pr-review", "issue-triage", "daily-summary", "backlog-cleanup"] as const) {
      expect(within(dialog).getAllByText(copy.templates[id].name).length).toBeGreaterThan(0);
    }
    await userEvent.click(within(dialog).getByText(copy.templates["daily-summary"].line));
    expect(within(screen.getByTestId("template-preview")).getByText(copy.templates["daily-summary"].example)).toBeInTheDocument();
  });

  it("a template fills step two with its name and soul, and says its schedule starts off", async () => {
    render(<Templates />);
    await userEvent.click(await screen.findByRole("button", { name: copy.create.useTemplate }));
    expect(screen.getByDisplayValue(copy.templates["ci-check"].name)).toBeInTheDocument();
    expect(screen.getByText(copy.create.schedulesOff)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.create.create.replace("{name}", copy.templates["ci-check"].name) })).toBeEnabled();
  });

  it("from scratch needs a description first, and starts the soul from it", async () => {
    render(<Templates />);
    const scratch = await screen.findByRole("button", { name: copy.create.fromScratch });
    expect(scratch).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: copy.create.step1 }), "watch my deploys");
    await userEvent.click(scratch);
    expect((screen.getAllByRole("textbox").find((box) => box.tagName === "TEXTAREA") as HTMLTextAreaElement).value).toContain("watch my deploys");
  });
});
