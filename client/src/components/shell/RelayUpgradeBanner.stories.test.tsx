import { composeStories } from "@storybook/react-vite";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stories from "./RelayUpgradeBanner.stories";
import { MANUAL_UPGRADE_COMMAND } from "@/hooks/relay/useLegacyRelayUpgrade";
import { en } from "@/i18n/en";

const { Available, Checking, WaitingForOne, WaitingForSeveral, Updating, Restarting, Done, Failed, FailedWithoutReason, Simulated } = composeStories(stories);
const copy = en.shell.relayUpgrade;

describe("Relay update notice stories", () => {
  afterEach(() => {
    act(() => cleanup());
    vi.useRealTimers();
  });

  it("offers one button, naming the profile", () => {
    const onUpdate = vi.fn();
    render(<Available onUpdate={onUpdate} />);
    expect(screen.getByText("Home server")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: copy.update }));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("while it works, says what it is doing and offers neither the button nor dismissing", () => {
    const cases: [typeof Checking, string][] = [
      [Checking, copy.checking],
      [WaitingForOne, copy.waitingOne],
      [WaitingForSeveral, copy.waitingMany.replace("{count}", "3")],
      [Updating, copy.updating],
      [Restarting, copy.restarting],
    ];
    for (const [Story, text] of cases) {
      render(<Story />);
      expect(screen.getByRole("status")).toHaveTextContent(text);
      expect(screen.queryByRole("button", { name: copy.update })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: copy.dismiss })).not.toBeInTheDocument();
      act(() => cleanup());
    }
  });

  it("done says so, without the button", () => {
    render(<Done />);
    expect(screen.getByText(copy.done)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.update })).not.toBeInTheDocument();
  });

  it("a failure gives the reason, the command for the relay's machine, and the button to try again", () => {
    render(<Failed />);
    expect(screen.getByText(copy.failedWithReason.replace("{error}", "the relay's terminal closed before the update ran"))).toBeInTheDocument();
    expect(screen.getByText(MANUAL_UPGRADE_COMMAND)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.update })).toBeInTheDocument();
    act(() => cleanup());
    render(<FailedWithoutReason />);
    expect(screen.getByText(copy.failed)).toBeInTheDocument();
  });

  it("the simulated flow walks from the button to done", () => {
    vi.useFakeTimers();
    render(<Simulated />);
    fireEvent.click(screen.getByRole("button", { name: copy.update }));
    expect(screen.getByRole("status")).toHaveTextContent(copy.checking);
    for (let i = 0; i < 4; i++) act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByText(copy.done)).toBeInTheDocument();
  });
});
