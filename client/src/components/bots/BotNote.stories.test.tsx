import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as stories from "./BotNote.stories";
import { en } from "@/i18n/en";

const turn = en.bots.turn;
const { Notes, PeerActivity } = composeStories(stories);

describe("Bot conversation notes", () => {
  afterEach(() => act(() => cleanup()));

  it("names the other bot in its messages, a task number where there is one", () => {
    render(<Notes />);
    const lines = Array.from(screen.getByTestId("bot-notes").querySelectorAll("p")).map((line) => line.textContent);
    expect(lines).toEqual([
      turn.schedule.replace("{name}", "CI check"),
      turn.created,
      turn.answer.replace("{n}", "13"),
      turn.canceled.replace("{n}", "8"),
      turn.peerAsk.replace("{name}", "Release"),
      turn.peerAnswer.replace("{name}", "Release"),
      turn.peerNoAnswer.replace("{name}", "Release"),
      turn.peerHandoff.replace("{name}", "Release").replace("{n}", "15"),
      turn.peerClosed.replace("{name}", "Fixer bot").replace("{n}", "4"),
    ]);
  });

  it("a call to another bot reads as a line naming that bot", () => {
    render(<PeerActivity />);
    const lines = Array.from(screen.getByTestId("bot-peer-activity").querySelectorAll("p")).map((line) => line.textContent);
    expect(lines).toEqual([en.bots.activity.peers, `${en.bots.activity.askedBot.replace("{name}", "Release")}What shipped yesterday?`, `${en.bots.activity.handedOff.replace("{name}", "Fixer bot")}Fix the flaky wakeup test`]);
  });
});
