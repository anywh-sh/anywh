import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./NewBotView.stories";
import { en } from "@/i18n/en";

const copy = en.bots;
const { Templates } = composeStories(stories);

describe("New bot tab stories", () => {
  afterEach(() => act(() => cleanup()));

  it("lists the five templates and previews the one picked", async () => {
    render(<Templates />);
    const view = await screen.findByTestId("new-bot-view");
    expect(within(view).getByText(copy.create.stepOf.replace("{step}", "1"))).toBeInTheDocument();
    for (const id of ["ci-check", "pr-review", "issue-triage", "daily-summary", "backlog-cleanup"] as const) {
      expect(within(view).getAllByText(copy.templates[id].name).length).toBeGreaterThan(0);
    }
    await userEvent.click(within(view).getByText(copy.templates["daily-summary"].line, { selector: "span" }));
    expect(within(screen.getByTestId("template-preview")).getByText(copy.templates["daily-summary"].example)).toBeInTheDocument();
  });

  it("a template fills step two with its name and soul, says its schedule starts off, and goes back to the templates", async () => {
    render(<Templates />);
    await userEvent.click(await screen.findByRole("button", { name: copy.create.useTemplate }));
    expect(screen.getByDisplayValue(copy.templates["ci-check"].name)).toBeInTheDocument();
    expect(screen.getByText(copy.create.schedulesOff)).toBeInTheDocument();
    expect(screen.getByText(copy.create.inSidebar)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.create.create.replace("{name}", copy.templates["ci-check"].name) })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: copy.create.templatesBack }));
    expect(screen.getByText(copy.create.step1)).toBeInTheDocument();
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
