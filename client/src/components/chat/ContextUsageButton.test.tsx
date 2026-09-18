import { afterEach, describe, expect, it, vi } from "vitest";
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
    render(<ContextUsageButton usage={USAGE} onOpen={() => {}} />);

    // The reason the turn indicator carries no token count of its own — so
    // the number has to be legible without opening anything.
    expect(screen.getByRole("button")).toHaveTextContent("128k/200k");
  });

  it("announces the percentage, which the compact label never spells out", () => {
    render(<ContextUsageButton usage={USAGE} onOpen={() => {}} />);

    expect(screen.getByRole("button")).toHaveAccessibleName(en.chat.composer.context.ariaLabel.replace("{percent}", "64"));
  });

  it("renders nothing at all before the session's first turn", () => {
    const { container } = render(<ContextUsageButton usage={null} onOpen={() => {}} />);

    // Deliberately absent rather than showing 0% — a session with no history
    // hasn't spent anything, and a zeroed ring reads like a measurement.
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the headline percentage, the occupied label and the used/total tokens as one line, before the bar", async () => {
    const user = userEvent.setup();
    render(<ContextUsageButton usage={USAGE} onOpen={() => {}} />);
    await user.click(screen.getByRole("button"));

    expect(screen.getByText("64%")).toBeInTheDocument();
    expect(screen.getByText(en.chat.composer.context.occupied)).toBeInTheDocument();
    expect(screen.getByText("128k / 200k tokens")).toBeInTheDocument();
  });

  it("shows the model and the window size together in the footer", async () => {
    const user = userEvent.setup();
    render(<ContextUsageButton usage={USAGE} onOpen={() => {}} />);
    await user.click(screen.getByRole("button"));

    expect(screen.getByText("claude-opus-5 · 200k window")).toBeInTheDocument();
  });

  it("shows the Setup line, with the real percent of the window, only when baselineTokens is known", async () => {
    const user = userEvent.setup();
    render(<ContextUsageButton usage={USAGE_WITH_BASELINE} onOpen={() => {}} />);
    await user.click(screen.getByRole("button"));

    // 45,448 / 200,000 = 22.724% — rounds to 23.
    expect(screen.getByText("Setup: 45k (23%)")).toBeInTheDocument();
  });

  it("omits the Setup line entirely for a usage with no baselineTokens (a record written before this field existed, or a resumed session)", async () => {
    const user = userEvent.setup();
    render(<ContextUsageButton usage={USAGE} onOpen={() => {}} />);
    await user.click(screen.getByRole("button"));

    expect(screen.queryByText(/^Setup:/)).not.toBeInTheDocument();
  });

  it("calls onOpen every time the popover opens, but not on close", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<ContextUsageButton usage={USAGE} onOpen={onOpen} />);

    await user.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  describe("with a detailed breakdown", () => {
    // Shaped like the two real defs' own accounting (see claude/def.ts and
    // codex.ts): only Claude ever declares `subagents`/`emptyDirectory`
    // (nonzero `emptyDirectoryInflation`); only Codex ever declares
    // `skills`. Neither def ever sends the other's exclusive category.
    const CLAUDE_SHAPED_USAGE: ContextUsage = {
      ...USAGE_WITH_BASELINE,
      breakdown: {
        rules: { tokens: 9490, estimated: true },
        subagents: { tokens: 614, count: 12, estimated: true },
        emptyDirectory: { tokens: 2233, estimated: true },
        residual: { tokens: 33111, estimated: false },
      },
    };
    const CODEX_SHAPED_USAGE: ContextUsage = {
      ...USAGE_WITH_BASELINE,
      breakdown: {
        rules: { tokens: 7669, estimated: true },
        skills: { tokens: 715, count: 12, estimated: true },
        residual: { tokens: 100, estimated: false },
      },
    };

    it("renders a line per category the breakdown actually returned, plus Conversation", async () => {
      const user = userEvent.setup();
      render(<ContextUsageButton usage={CLAUDE_SHAPED_USAGE} onOpen={() => {}} />);
      await user.click(screen.getByRole("button"));

      expect(screen.getByText(en.chat.composer.context.breakdownRules)).toBeInTheDocument();
      expect(screen.getByText(en.chat.composer.context.breakdownSubagents)).toBeInTheDocument();
      expect(screen.getByText(en.chat.composer.context.breakdownSystemPromptTools)).toBeInTheDocument();
      expect(screen.getByText(en.chat.composer.context.breakdownConversation)).toBeInTheDocument();
    });

    it("shows each category's own share of the window as a percentage, not just its width in the bar", async () => {
      const user = userEvent.setup();
      render(<ContextUsageButton usage={CLAUDE_SHAPED_USAGE} onOpen={() => {}} />);
      await user.click(screen.getByRole("button"));

      expect(screen.getByText("5%")).toBeInTheDocument(); // rules: 9490 / 200000
      expect(screen.getByText("<1%")).toBeInTheDocument(); // subagents: 614 / 200000
      expect(screen.getByText("1%")).toBeInTheDocument(); // emptyDirectory: 2233 / 200000
      expect(screen.getByText("17%")).toBeInTheDocument(); // residual: 33111 / 200000
      expect(screen.getByText("41%")).toBeInTheDocument(); // conversation: 82552 / 200000
    });

    it("never renders a Skills line for a Claude-shaped breakdown (the def declares no skills accounting)", async () => {
      const user = userEvent.setup();
      render(<ContextUsageButton usage={CLAUDE_SHAPED_USAGE} onOpen={() => {}} />);
      await user.click(screen.getByRole("button"));

      expect(screen.queryByText(en.chat.composer.context.breakdownSkills)).not.toBeInTheDocument();
    });

    it("never renders a Subagents line for a Codex-shaped breakdown (no such concept), but does render Skills", async () => {
      const user = userEvent.setup();
      render(<ContextUsageButton usage={CODEX_SHAPED_USAGE} onOpen={() => {}} />);
      await user.click(screen.getByRole("button"));

      expect(screen.getByText(en.chat.composer.context.breakdownSkills)).toBeInTheDocument();
      expect(screen.queryByText(en.chat.composer.context.breakdownSubagents)).not.toBeInTheDocument();
    });

    it("shows the empty-folder line only when the relay reported one", async () => {
      const user = userEvent.setup();
      render(<ContextUsageButton usage={CLAUDE_SHAPED_USAGE} onOpen={() => {}} />);
      await user.click(screen.getByRole("button"));

      expect(screen.getByText(en.chat.composer.context.breakdownEmptyDirectory)).toBeInTheDocument();
    });

    it("omits the empty-folder line for a Codex-shaped breakdown, which never reports one", async () => {
      const user = userEvent.setup();
      render(<ContextUsageButton usage={CODEX_SHAPED_USAGE} onOpen={() => {}} />);
      await user.click(screen.getByRole("button"));

      expect(screen.queryByText(en.chat.composer.context.breakdownEmptyDirectory)).not.toBeInTheDocument();
    });

    it("falls back to the simple Setup line when no breakdown has arrived yet, even with a baseline known", async () => {
      const user = userEvent.setup();
      render(<ContextUsageButton usage={USAGE_WITH_BASELINE} onOpen={() => {}} />);
      await user.click(screen.getByRole("button"));

      expect(screen.getByText("Setup: 45k (23%)")).toBeInTheDocument();
      expect(screen.queryByText(en.chat.composer.context.breakdownRules)).not.toBeInTheDocument();
    });
  });
});
