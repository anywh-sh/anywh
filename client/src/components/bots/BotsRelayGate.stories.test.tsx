import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./BotsRelayGate.stories";
import { RELAY_UPDATE_COMMAND } from "@/components/bots/BotsRelayGate";
import { en } from "@/i18n/en";

const { OtherMachine, VersionUnknown } = composeStories(stories);

describe("Bots relay gate stories", () => {
  afterEach(() => act(() => cleanup()));

  it("a relay on another machine gets the command to run there", () => {
    render(<OtherMachine />);
    expect(screen.getByText(en.bots.relayGate.title)).toBeInTheDocument();
    expect(screen.getByText(en.bots.relayGate.manualHint)).toBeInTheDocument();
    expect(screen.getByText(RELAY_UPDATE_COMMAND)).toBeInTheDocument();
  });

  it("without a version to compare (a build from source), it says the relay predates bots", () => {
    render(<VersionUnknown />);
    expect(screen.getByText(en.bots.relayGate.bodyUnknown)).toBeInTheDocument();
  });
});
