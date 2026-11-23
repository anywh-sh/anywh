import { composeStories } from "@storybook/react-vite";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stories from "./RelayUpgradeBanner.stories";
import { MANUAL_BREW_COMMAND, MANUAL_UPGRADE_COMMAND } from "@/hooks/relay/useLegacyRelayUpgrade";
import { en } from "@/i18n/en";

const { Available, AvailableEachTime, Checking, WaitingForOne, WaitingForSeveral, Updating, Restarting, Done, Failed, InstallerFailed, HomebrewFailed, HomebrewTimedOut, HomebrewAlreadyRunning, NotPublished, Simulated } =
  composeStories(stories);
const copy = en.shell.relayUpgrade;

describe("Relay update notice stories", () => {
  it("Homebrew having nothing newer yet is said as such, not as a failure, with no command and the button to try later", () => {
    const onUpdate = vi.fn();
    render(<NotPublished onUpdate={onUpdate} />);
    expect(screen.getByText(copy.notPublished)).toBeInTheDocument();
    expect(screen.queryByText(copy.runThere)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: copy.update }));
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: copy.dismiss })).toBeInTheDocument();
  });

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

  it("a Homebrew relay is not promised that it keeps itself up to date", () => {
    render(<AvailableEachTime />);
    expect(screen.getByTestId("relay-upgrade-notice")).toHaveTextContent(copy.bodyEachTime.replace("{profile}", "Home server"));
    expect(screen.getByTestId("relay-upgrade-notice")).not.toHaveTextContent("keeps itself up to date");
  });

  it("while it works, says what it is doing and offers no button", () => {
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
      act(() => cleanup());
    }
  });

  it("done says so, without the button", () => {
    render(<Done />);
    expect(screen.getByText(copy.done)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.update })).not.toBeInTheDocument();
  });

  it("a failure says why in the person's language, gives the command for the relay's machine, and the button to try again", () => {
    render(<Failed />);
    expect(screen.getByText(copy.failedReasons.terminal)).toBeInTheDocument();
    expect(screen.getByText(copy.runThere)).toBeInTheDocument();
    expect(screen.getByText(MANUAL_UPGRADE_COMMAND)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.update })).toBeInTheDocument();
    act(() => cleanup());
    render(<InstallerFailed />);
    expect(screen.getByText(copy.failedReasons.installer)).toBeInTheDocument();
    expect(screen.getByText("checksum mismatch for anywh-relay-0.2.50-linux-x64.tar.gz")).toBeInTheDocument();
  });

  it("a Homebrew run the app made on this Mac says how it ended, with the brew command to run by hand", () => {
    render(<HomebrewFailed />);
    expect(screen.getByText(copy.failedReasons.homebrew)).toBeInTheDocument();
    expect(screen.getByText("Error: anywh-relay: SHA256 mismatch")).toBeInTheDocument();
    expect(screen.getByText(MANUAL_BREW_COMMAND)).toBeInTheDocument();
    act(() => cleanup());
    render(<HomebrewTimedOut />);
    expect(screen.getByText(copy.failedReasons.timed_out)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.update })).toBeInTheDocument();
    act(() => cleanup());
    render(<HomebrewAlreadyRunning />);
    expect(screen.getByText(copy.failedReasons.already_running)).toBeInTheDocument();
  });

  it("checking and waiting can be called off; an update already running cannot", () => {
    const onDismiss = vi.fn();
    render(<WaitingForOne onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: copy.dismiss }));
    expect(onDismiss).toHaveBeenCalledOnce();
    act(() => cleanup());
    render(<Updating />);
    expect(screen.queryByRole("button", { name: copy.dismiss })).not.toBeInTheDocument();
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
