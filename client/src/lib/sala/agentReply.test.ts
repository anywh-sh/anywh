import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/lib/relay/relayClient";
import { applyReplyEvent, emptyReply, replyFromHistory, shouldShowReply } from "@/lib/sala/agentReply";

const fold = (events: AgentEvent[]) => events.reduce(applyReplyEvent, emptyReply);

describe("applyReplyEvent", () => {
  it("streams the block being written", () => {
    const reply = fold([
      { type: "turn_started" },
      { type: "text_delta", index: 0, text: "Hel" },
      { type: "text_delta", index: 0, text: "lo" },
    ]);
    expect(reply).toMatchObject({ text: "Hello", running: true, error: null, turns: 1 });
  });

  it("replaces the stream with the committed text", () => {
    const reply = fold([{ type: "turn_started" }, { type: "text_delta", index: 0, text: "Hel" }, { type: "text", text: "Hello." }, { type: "turn_ended", stopped: false }]);
    expect(reply).toMatchObject({ text: "Hello.", running: false, streaming: {} });
  });

  it("keeps the last block while a tool runs, then follows the next block", () => {
    const mid = fold([{ type: "turn_started" }, { type: "text", text: "Looking." }, { type: "tool_started", name: "Read", kind: "read", input: {} }]);
    expect(mid.text).toBe("Looking.");
    const next = applyReplyEvent(mid, { type: "text_delta", index: 1, text: "Found" });
    expect(next.text).toBe("Found");
  });

  it("starts a new turn from a blank reply", () => {
    const reply = fold([{ type: "turn_started" }, { type: "text", text: "First." }, { type: "turn_ended", stopped: false }, { type: "turn_started" }]);
    expect(reply).toMatchObject({ text: "", running: true, turns: 2 });
  });

  it("commits a partial block when the turn is stopped", () => {
    const reply = fold([{ type: "turn_started" }, { type: "text_delta", index: 0, text: "Half" }, { type: "turn_ended", stopped: true }]);
    expect(reply).toMatchObject({ text: "Half", running: false });
  });

  it("records the error of a failed turn and clears it on the next", () => {
    const failed = fold([{ type: "turn_started" }, { type: "error", message: "boom" }]);
    expect(failed).toMatchObject({ error: "boom", running: false });
    expect(applyReplyEvent(failed, { type: "turn_started" }).error).toBeNull();
  });

  it("ignores subagent prose and the interruption marker", () => {
    const reply = fold([{ type: "turn_started" }, { type: "text", text: "Mine." }, { type: "text", text: "Theirs.", parentToolUseId: "t1" }, { type: "text", text: "[Request interrupted by user]" }]);
    expect(reply.text).toBe("Mine.");
  });
});

describe("replyFromHistory", () => {
  it("takes the last text of the last turn", () => {
    const events: AgentEvent[] = [
      { type: "turn_started" },
      { type: "text", text: "Task done." },
      { type: "turn_ended", stopped: false },
      { type: "user_message", text: "and now?" },
      { type: "turn_started" },
      { type: "text", text: "Draft." },
      { type: "text", text: "Answer." },
      { type: "turn_ended", stopped: false },
    ];
    expect(replyFromHistory(events.map((event) => ({ type: "agent_event", event })))).toMatchObject({ text: "Answer.", running: false, turns: 2 });
  });

  it("is empty for an agent that never spoke", () => {
    expect(replyFromHistory([])).toEqual(emptyReply);
  });
});

describe("shouldShowReply", () => {
  const done = { ...emptyReply, text: "Done.", turns: 1 };
  it("hides the task turn once over when the report already says it", () => {
    expect(shouldShowReply(done, true)).toBe(false);
    expect(shouldShowReply(done, false)).toBe(true);
  });
  it("shows an answer to a later message even with a report", () => {
    expect(shouldShowReply({ ...done, turns: 2 }, true)).toBe(true);
  });
  it("shows a running or failed turn, and nothing for no text", () => {
    expect(shouldShowReply({ ...emptyReply, running: true, turns: 1 }, true)).toBe(true);
    expect(shouldShowReply({ ...emptyReply, error: "x", turns: 1 }, true)).toBe(true);
    expect(shouldShowReply(emptyReply, false)).toBe(false);
  });
});
