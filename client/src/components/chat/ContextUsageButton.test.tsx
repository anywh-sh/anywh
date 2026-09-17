import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ContextUsageButton } from "./ContextUsageButton";
import { en } from "@/i18n/en";
import type { ContextUsage } from "@/lib/relay/relayClient";

afterEach(() => cleanup());

const USAGE: ContextUsage = { model: "claude-opus-5", contextWindowSize: 200_000, usedTokens: 128_000 };

describe("ContextUsageButton", () => {
  it("reads the spend and the window on the chip itself, not only in the popover", () => {
    render(<ContextUsageButton usage={USAGE} />);

    // The reason the turn indicator carries no token count of its own — so
    // the number has to be legible without opening anything.
    expect(screen.getByRole("button")).toHaveTextContent("128k/200k");
  });

  it("announces the percentage, which the compact label never spells out", () => {
    render(<ContextUsageButton usage={USAGE} />);

    expect(screen.getByRole("button")).toHaveAccessibleName(en.chat.composer.context.ariaLabel.replace("{percent}", "64"));
  });

  it("renders nothing at all before the session's first turn", () => {
    const { container } = render(<ContextUsageButton usage={null} />);

    // Deliberately absent rather than showing 0% — a session with no history
    // hasn't spent anything, and a zeroed ring reads like a measurement.
    expect(container).toBeEmptyDOMElement();
  });
});
