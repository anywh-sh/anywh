import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./NewBotView.stories";
import { en } from "@/i18n/en";
import { storyBots, storyProfile } from "@/components/bots/botStoryData";
import { resetBotsStore, setBots } from "@/lib/bots/botsStore";

const copy = en.bots;
const { Templates, FirstBot } = composeStories(stories);

describe("New bot tab stories", () => {
  afterEach(() => {
    act(() => cleanup());
    resetBotsStore();
  });

  /** The bots store as the story's `beforeEach` sets it in Storybook. */
  function renderStory(Story: typeof Templates) {
    setBots(storyProfile.id, Story === FirstBot ? [] : storyBots);
    return render(<Story />);
  }

  it("a profile with no bot opens on a presentation, whose ways in lead to the templates", async () => {
    renderStory(FirstBot);
    expect(screen.getByTestId("new-bot-intro")).toBeInTheDocument();
    expect(screen.getByText(copy.create.intro.title)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: copy.create.intro.seeTemplates.replace("{count}", "5") }));
    expect(screen.getByText(copy.create.step1)).toBeInTheDocument();
  });

  it("lists the five templates and previews the one picked", async () => {
    renderStory(Templates);
    const view = await screen.findByTestId("new-bot-view");
    expect(within(view).getByText(copy.create.stepOf.replace("{step}", "1"))).toBeInTheDocument();
    for (const id of ["ci-check", "pr-review", "issue-triage", "daily-summary", "backlog-cleanup"] as const) {
      expect(within(view).getAllByText(copy.templates[id].name).length).toBeGreaterThan(0);
    }
    await userEvent.click(within(view).getByText(copy.templates["daily-summary"].line, { selector: "span" }));
    expect(within(screen.getByTestId("template-preview")).getByText(copy.templates["daily-summary"].example)).toBeInTheDocument();
  });

  it("a template fills step two with its name and soul, says its schedule starts off, and goes back to the templates", async () => {
    renderStory(Templates);
    await userEvent.click(await screen.findByRole("button", { name: copy.create.useTemplate }));
    expect(screen.getByDisplayValue(copy.templates["ci-check"].name)).toBeInTheDocument();
    expect(screen.getByText(copy.create.schedulesOff)).toBeInTheDocument();
    expect(screen.queryByTestId("new-bot-preview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.create.create.replace("{name}", copy.templates["ci-check"].name) })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: copy.create.templatesBack }));
    expect(screen.getByText(copy.create.step1)).toBeInTheDocument();
  });

  it("from scratch needs a description first, and starts the soul from it", async () => {
    renderStory(Templates);
    const scratch = await screen.findByRole("button", { name: copy.create.fromScratch });
    expect(scratch).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: copy.create.step1 }), "watch my deploys");
    await userEvent.click(scratch);
    expect((screen.getAllByRole("textbox").find((box) => box.tagName === "TEXTAREA") as HTMLTextAreaElement).value).toContain("watch my deploys");
  });

  it("a drawn face stays as it is while the name is typed, and the template's schedule can start on", async () => {
    const { container } = renderStory(Templates);
    await userEvent.click(await screen.findByRole("button", { name: copy.create.useTemplate }));
    const face = () => container.querySelector('svg[width="96"]')?.innerHTML;
    const before = face();
    await userEvent.click(screen.getByRole("button", { name: copy.create.reroll }));
    const drawn = face();
    expect(drawn).not.toBe(before);
    await userEvent.type(screen.getByDisplayValue(copy.templates["ci-check"].name), " two");
    expect(face()).toBe(drawn);
    const schedule = screen.getByRole("switch", { name: copy.templates["ci-check"].scheduleName });
    expect(schedule).not.toBeChecked();
    expect(screen.getByText(copy.create.schedulesOff)).toBeInTheDocument();
    await userEvent.click(schedule);
    expect(schedule).toBeChecked();
    expect(screen.getByText(copy.templates["ci-check"].when)).toBeInTheDocument();
  });
});
