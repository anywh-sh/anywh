import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./AgentModelEffortButton.stories";
import { en } from "@/i18n/en";

const copy = en.chat.composer;
const { Playground, Claude, EffortSubmenu, MoreModels, AgentSubmenu, CodexEffort, Kimi, KimiMoreModels, Locked, SingleAgent, Pending } = composeStories(stories);

describe("AgentModelEffortMenu stories", () => {
  afterEach(() => act(() => cleanup()));

  it("Playground starts closed, reading model and effort on the trigger", async () => {
    render(<Playground />);
    const trigger = await screen.findByRole("button");
    expect(trigger).toHaveTextContent("Opus 5.5");
    expect(trigger).toHaveTextContent(copy.effortDefault.toLowerCase());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Claude lists the four aliases on top, the rest behind More models", async () => {
    render(<Claude />);
    for (const name of ["Opus 5.5", "Fable 5.2", "Sonnet 5.5", "Haiku 5.5"]) expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Opus 4\.8/ })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: copy.menu.moreModels })).toBeInTheDocument();
  });

  it("EffortSubmenu explains the cost and checks the pick", async () => {
    render(<EffortSubmenu />);
    expect(await screen.findByText(copy.menu.effortHint)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: copy.effortDefault })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Extra high" })).toBeInTheDocument();
  });

  it("MoreModels names the superseded model the session is on", async () => {
    render(<MoreModels />);
    expect(await screen.findByRole("menuitem", { name: `${copy.menu.moreModels} Opus 4.6` })).toBeInTheDocument();
    expect(await screen.findByRole("menuitem", { name: "Sonnet 4.6" })).toBeInTheDocument();
  });

  it("AgentSubmenu swaps the catalog when another agent is picked", async () => {
    const user = userEvent.setup();
    render(<AgentSubmenu />);
    await user.click(await screen.findByRole("menuitem", { name: new RegExp(copy.agentNames.codex) }));
    expect(await screen.findByRole("button")).toHaveTextContent("GPT-5.6-Terra");
  });

  it("CodexEffort badges the CLI's own default level and has no More models", async () => {
    render(<CodexEffort />);
    expect(await screen.findByRole("menuitem", { name: `Medium ${copy.effortDefault}` })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: copy.menu.moreModels })).not.toBeInTheDocument();
  });

  it("Kimi keeps its newest generation on top, one per purpose", async () => {
    render(<Kimi />);
    expect(await screen.findByRole("menuitem", { name: "K3.1 Pro" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "K3.1 Pro Highspeed 2x Usage Cost" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "K3" })).not.toBeInTheDocument();
    // The CLI's default is an older generation: the More models row names it.
    expect(screen.getByRole("menuitem", { name: `${copy.menu.moreModels} K2.8 Preview` })).toBeInTheDocument();
  });

  it("KimiMoreModels lists the older generations", async () => {
    render(<KimiMoreModels />);
    expect(await screen.findByRole("menuitem", { name: "K2.7 Code Highspeed" })).toBeInTheDocument();
  });

  it("Locked fixes model and agent but keeps effort", async () => {
    render(<Locked />);
    expect(await screen.findByText(copy.menu.fixedInSession)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: new RegExp(`^${copy.menu.agent}`) })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: `${copy.menu.effort} Max` })).toBeInTheDocument();
  });

  it("SingleAgent has no agent row", async () => {
    render(<SingleAgent />);
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: new RegExp(`^${copy.menu.agent}`) })).not.toBeInTheDocument();
  });

  it("Pending is a disabled trigger", async () => {
    render(<Pending />);
    expect(await screen.findByRole("button")).toBeDisabled();
  });
});
