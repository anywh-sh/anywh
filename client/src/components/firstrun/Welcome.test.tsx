import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreparingFailure } from "@/components/firstrun/PreparingFailure";
import { Welcome } from "@/components/firstrun/Welcome";
import { en } from "@/i18n/en";
import { ptBr } from "@/i18n/pt-br";
import type { PreparingFailureCode } from "@/lib/install/localInstall";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const welcome = en.firstRun.welcome;

function renderWelcome(props: Partial<Parameters<typeof Welcome>[0]> = {}) {
  const handlers = {
    onSetUp: vi.fn(),
    onTerminal: vi.fn(),
    onOtherMachine: vi.fn(),
  };
  render(<Welcome {...handlers} {...props} />);
  return handlers;
}

describe("Welcome", () => {
  it("one primary way in, and a quiet one around it", async () => {
    const user = userEvent.setup();
    const handlers = renderWelcome();
    expect(screen.getByRole("heading", { name: welcome.title })).toBeInTheDocument();
    expect(screen.getByText(welcome.ctaHint)).toBeInTheDocument();
    // The agents are the agents step's to list, not the welcome's.
    expect(screen.queryByText(en.chat.composer.agentNames.claude)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: welcome.cta }));
    expect(handlers.onSetUp).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: welcome.otherMachine }));
    expect(handlers.onOtherMachine).toHaveBeenCalledTimes(1);
  });

  it("on Windows says WSL2 is needed, lists what to have, and leads to the terminal", async () => {
    const user = userEvent.setup();
    const handlers = renderWelcome({ windows: true });
    expect(screen.getByRole("note")).toHaveTextContent(welcome.windows.notice);
    const steps = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent(welcome.windows.steps.wsl.title);
    expect(
      within(steps[0]).getByRole("link", {
        name: welcome.windows.steps.wsl.link,
      }),
    ).toHaveAttribute("href", "https://learn.microsoft.com/windows/wsl/install");
    expect(steps[1]).toHaveTextContent(welcome.windows.steps.agent.title);
    // No in-app install to offer on Windows.
    expect(screen.queryByRole("button", { name: welcome.cta })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: welcome.windows.cta }));
    expect(handlers.onTerminal).toHaveBeenCalledTimes(1);
    expect(handlers.onSetUp).not.toHaveBeenCalled();
  });

  it("inside a sandbox the in-app install is off, with the reason and the terminal instead", async () => {
    const user = userEvent.setup();
    const handlers = renderWelcome({ container: "flatpak" });
    expect(screen.getByRole("button", { name: welcome.cta })).toBeDisabled();
    expect(screen.getByText(welcome.container.replace("{container}", "flatpak"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: welcome.containerTerminal }));
    expect(handlers.onTerminal).toHaveBeenCalledTimes(1);
  });
});

describe("PreparingFailure", () => {
  it("brew_missing offers the install command, brew.sh, and check again before the terminal", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<PreparingFailure code="brew_missing" onAction={onAction} />);
    const codes = en.firstRun.preparing.fail.codes;
    expect(screen.getByRole("alert")).toHaveTextContent(codes.brew_missing.body);
    expect(screen.getByText(codes.brew_missing.command ?? "")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "brew.sh" })).toHaveAttribute("href", "https://brew.sh");
    const buttons = within(screen.getByRole("alert"))
      .getAllByRole("button")
      .filter((b) => b.textContent !== en.firstRun.copy.copy);
    expect(buttons.map((b) => b.textContent)).toEqual([en.firstRun.preparing.fail.actions.recheck, en.firstRun.preparing.fail.actions.terminal]);
    await user.click(buttons[0]);
    expect(onAction).toHaveBeenCalledWith("recheck");
  });

  it("every code has copy in both languages, and none of it says relay", () => {
    for (const dict of [en, ptBr]) {
      const codes = dict.firstRun.preparing.fail.codes;
      for (const code of Object.keys(codes) as PreparingFailureCode[]) {
        expect(codes[code].body.length, code).toBeGreaterThan(0);
        expect(JSON.stringify(codes[code]), code).not.toMatch(/relay/i);
      }
    }
  });
});
