import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./BotsRelayGate.stories";
import { RELAY_UPDATE_COMMAND } from "@/components/bots/BotsRelayGate";
import { en } from "@/i18n/en";

const { OtherMachine, VersionUnknown, UpdateOffered, Waiting, Failed } = composeStories(stories);
const upgrade = en.shell.relayUpgrade;

describe("Bots relay gate stories", () => {
  afterEach(() => act(() => cleanup()));

  it("a relay on another machine gets the command to run there", () => {
    render(<OtherMachine />);
    expect(screen.getByText(en.bots.relayGate.title)).toBeInTheDocument();
    expect(screen.getByText(en.bots.relayGate.manualHint)).toBeInTheDocument();
    expect(screen.getByText(RELAY_UPDATE_COMMAND)).toBeInTheDocument();
  });

  it("names the relay's current version, not a minimum", () => {
    render(<OtherMachine />);
    expect(screen.getByText(en.bots.relayGate.body.replace("{current}", "v0.2.40"))).toBeInTheDocument();
  });

  it("without a version to compare (a build from source), it says the relay predates bots", () => {
    render(<VersionUnknown />);
    expect(screen.getByText(en.bots.relayGate.bodyUnknown)).toBeInTheDocument();
  });

  it("an older relay the app can update gets the one button", () => {
    render(<UpdateOffered />);
    expect(screen.getByRole("button", { name: upgrade.update })).toBeInTheDocument();
    expect(screen.queryByText(RELAY_UPDATE_COMMAND)).not.toBeInTheDocument();
  });

  it("while a reply runs, it says it is waiting", () => {
    render(<Waiting />);
    expect(screen.getByRole("status")).toHaveTextContent(upgrade.waitingOne);
  });

  it("a failure says why, with the installer's words and the command for the relay's machine", () => {
    render(<Failed />);
    expect(screen.getByText(upgrade.failedReasons.installer)).toBeInTheDocument();
    expect(screen.getByText("checksum mismatch for anywh-relay-0.2.50-linux-x64.tar.gz")).toBeInTheDocument();
    expect(screen.getByText(upgrade.runThere)).toBeInTheDocument();
  });
});
