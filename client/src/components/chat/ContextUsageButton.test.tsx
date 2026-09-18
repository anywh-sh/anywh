import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextUsageButton } from "./ContextUsageButton";
import { en } from "@/i18n/en";
import type { ContextUsage } from "@/lib/relay/relayClient";

afterEach(() => cleanup());

const USAGE: ContextUsage = { model: "claude-opus-5", contextWindowSize: 200_000, usedTokens: 128_000 };
const USAGE_WITH_BASELINE: ContextUsage = { ...USAGE, baselineTokens: 45_448 };

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

  it("shows the Setup line, with the real percent of the window, only when baselineTokens is known", async () => {
    const user = userEvent.setup();
    render(<ContextUsageButton usage={USAGE_WITH_BASELINE} />);
    await user.click(screen.getByRole("button"));

    // 45,448 / 200,000 = 22.724% — rounds to 23.
    expect(screen.getByText("Setup: 45k (23%)")).toBeInTheDocument();
  });

  it("omits the Setup line entirely for a usage with no baselineTokens (a record written before this field existed, or a resumed session)", async () => {
    const user = userEvent.setup();
    render(<ContextUsageButton usage={USAGE} />);
    await user.click(screen.getByRole("button"));

    expect(screen.queryByText(/^Setup:/)).not.toBeInTheDocument();
  });

  it("always shows the output-tokens caveat, regardless of baselineTokens", async () => {
    const user = userEvent.setup();
    render(<ContextUsageButton usage={USAGE} />);
    await user.click(screen.getByRole("button"));

    expect(screen.getByText(en.chat.composer.context.outputCaveat)).toBeInTheDocument();
  });

  it("lists top consumers sorted by tokens descending, capped at 5", async () => {
    const user = userEvent.setup();
    const usage: ContextUsage = {
      ...USAGE,
      sources: {
        Bash: { tokens: 194_164, calls: 329 },
        Read: { tokens: 104_764, calls: 89 },
        Edit: { tokens: 8_293, calls: 75 },
        Grep: { tokens: 1_000, calls: 3 },
        Write: { tokens: 900, calls: 1 },
        WebSearch: { tokens: 100, calls: 1 },
      },
    };
    render(<ContextUsageButton usage={usage} />);
    await user.click(screen.getByRole("button"));

    expect(screen.getByText(en.chat.composer.context.topConsumers)).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("194k · 329×")).toBeInTheDocument();
    // 6th-largest source (WebSearch, 100 tokens) doesn't make the top 5.
    expect(screen.queryByText("WebSearch")).not.toBeInTheDocument();
  });

  it("hides the top-consumers section entirely when the session has no attributed source yet", async () => {
    const user = userEvent.setup();
    render(<ContextUsageButton usage={USAGE} />);
    await user.click(screen.getByRole("button"));

    expect(screen.queryByText(en.chat.composer.context.topConsumers)).not.toBeInTheDocument();
  });
});
