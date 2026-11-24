import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stories from "./BotActivityLine.stories";
import { en } from "@/i18n/en";

const { Asked, Created, Remembered, AskedWithoutPanel } = composeStories(stories);

describe("Bot activity line stories", () => {
  afterEach(() => act(() => cleanup()));

  it("Asked is a button that opens its task", async () => {
    const onOpenTask = vi.fn();
    render(<Asked onOpenTask={onOpenTask} />);
    const line = screen.getByRole("button", { name: new RegExp(en.bots.task.open.replace("{n}", "2")) });
    expect(line).toHaveAttribute("title", en.bots.task.open.replace("{n}", "2"));
    await userEvent.click(line);
    expect(onOpenTask).toHaveBeenCalledWith(2);
  });

  it("Created opens its task as well", async () => {
    const onOpenTask = vi.fn();
    render(<Created onOpenTask={onOpenTask} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onOpenTask).toHaveBeenCalledWith(3);
  });

  it("a line without a task, or without a panel to open, is not a button", () => {
    render(<Remembered />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Deploys happen on Fridays")).toBeInTheDocument();
    cleanup();
    render(<AskedWithoutPanel />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(en.bots.activity.asked.replace("{n}", "2"))).toBeInTheDocument();
  });
});
