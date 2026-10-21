import { describe, expect, it } from "vitest";
import type { RoomAgent } from "@/lib/relay/roomClient";
import { cardActivity, cardClock, cardLines, cardStatus, firstLine, formatClock, trackStateSince } from "@/lib/sala/agentCard";

function agent(over: Partial<RoomAgent> = {}): RoomAgent {
  return {
    agentId: "a1",
    role: "worker",
    parentId: "p",
    title: "Do the thing",
    runtime: "claude",
    model: "haiku",
    createdBy: "agent",
    state: "working",
    queuedMessages: 0,
    needsYou: [],
    subtasksRunning: 0,
    connectors: [],
    ...over,
  };
}

describe("cardStatus", () => {
  it.each([
    ["working", "run", "running"],
    ["queued", "start", "starting"],
    ["waiting", "idle", "idle"],
    ["done", "done", "done"],
    ["failed", "fail", "failed"],
    ["blocked", "block", "blocked"],
    ["stopped", "stop", "stopped"],
    ["awaiting_user", "wait", "yourTurn"],
  ] as const)("%s -> %s", (state, tone, label) => {
    expect(cardStatus(agent({ state }))).toEqual({ tone, label });
  });

  it("puts what waits for the person above what the agent is doing", () => {
    const needsYou = [{ kind: "choice" as const, promptId: "q", count: 1 }];
    expect(cardStatus(agent({ state: "working", needsYou })).label).toBe("yourTurn");
    expect(cardStatus(agent({ state: "done", needsYou })).label).toBe("yourTurn");
  });

  it("reads a principal that finished delegating as running while its workers work, and as waiting once they are not", () => {
    const main = agent({ role: "principal", state: "waiting" });
    expect(cardStatus(main, 3)).toEqual({ tone: "run", label: "running" });
    expect(cardStatus(main, 0)).toEqual({ tone: "idle", label: "idle" });
    // Only the principal: an idle worker is idle whatever its siblings do.
    expect(cardStatus(agent({ state: "waiting" }), 3).tone).toBe("idle");
    // And a question from it still outranks the coordinating.
    expect(cardStatus({ ...main, state: "awaiting_user", needsYou: [{ kind: "choice", promptId: "q", count: 1 }] }, 3).label).toBe("yourTurn");
  });

  it("but a stop is final, whatever was left waiting", () => {
    const needsYou = [{ kind: "approval" as const, promptId: "q", count: 1 }];
    expect(cardStatus(agent({ state: "stopped", needsYou })).label).toBe("stopped");
  });
});

describe("cardActivity", () => {
  it("says a working principal coordinates its workers", () => {
    expect(cardActivity(agent({ role: "principal", state: "working" }), 3)).toEqual({ kind: "coordinating", agents: 3 });
  });
  it("says an idle principal coordinates while its workers work", () => {
    expect(cardActivity(agent({ role: "principal", state: "waiting" }), 4, 2)).toEqual({ kind: "coordinating", agents: 4 });
    expect(cardActivity(agent({ role: "principal", state: "waiting" }), 4, 0)).toEqual({ kind: "coordinating", agents: 4 });
  });
  it("counts a worker's running subtasks", () => {
    expect(cardActivity(agent({ subtasksRunning: 2 }), 0)).toEqual({ kind: "working", subtasks: 2 });
  });
  it("tells a question from an approval", () => {
    expect(cardActivity(agent({ state: "awaiting_user", needsYou: [{ kind: "approval", promptId: "x", count: 2 }] }), 0)).toEqual({ kind: "needsApproval", count: 2 });
    expect(cardActivity(agent({ state: "awaiting_user", needsYou: [{ kind: "choice", promptId: "x", count: 1 }] }), 0)).toEqual({ kind: "needsAnswer", count: 1 });
  });
  it("shows the first line of a finished agent's report", () => {
    const report = { status: "done" as const, summary: "\n  6 apps checked\nmore detail", artifacts: [], at: 1 };
    expect(cardActivity(agent({ state: "done", report }), 0)).toEqual({ kind: "report", text: "6 apps checked" });
  });
  it("notes queued messages", () => {
    expect(cardActivity(agent({ state: "queued", queuedMessages: 2 }), 0)).toEqual({ kind: "queued", messages: 2 });
  });
});

describe("firstLine", () => {
  it("cuts a long line with an ellipsis", () => {
    const text = firstLine("x".repeat(300), 20);
    expect(text).toHaveLength(20);
    expect(text.endsWith("…")).toBe(true);
  });
  it("is empty for blank text", () => {
    expect(firstLine("  \n ")).toBe("");
  });
});

describe("cardClock", () => {
  it("counts a wait from when the person was asked", () => {
    expect(cardClock(agent({ state: "awaiting_user", needsYou: [{ kind: "choice", promptId: "q", askedAt: 500, count: 1 }] }), 9000)).toEqual({ kind: "waiting", since: 500 });
  });
  it("counts a finish from the report", () => {
    expect(cardClock(agent({ state: "done", report: { status: "done", summary: "x", artifacts: [], at: 700 } }), 9000)).toEqual({ kind: "done", since: 700 });
  });
  it("counts a run from the relay's start and reports how long a finished one took", () => {
    expect(cardClock(agent({ state: "working", startedAt: 1000 }), 9000)).toEqual({ kind: "running", since: 1000 });
    expect(cardClock(agent({ state: "done", startedAt: 1000, report: { status: "done", summary: "x", artifacts: [], at: 4000 } }), 9000)).toEqual({ kind: "done", since: 4000, took: 3000 });
    expect(cardClock(agent({ state: "failed", startedAt: 5000, report: { status: "failed", summary: "x", artifacts: [], at: 4000 } }), 9000)).toEqual({ kind: "failed", since: 4000 });
  });
  it("shows no clock for an agent that is only idle", () => {
    expect(cardClock(agent({ state: "waiting" }), 9000).kind).toBe("none");
    expect(cardClock(agent({ state: "queued" }), 9000).kind).toBe("starting");
  });
  it("falls back to when the screen first saw the state", () => {
    expect(cardClock(agent({ state: "working" }), 9000)).toEqual({ kind: "running", since: 9000 });
    expect(cardClock(agent({ state: "awaiting_user", needsYou: [{ kind: "choice", promptId: "q", count: 1 }] }), 9000)).toEqual({ kind: "waiting", since: 9000 });
  });
});

describe("formatClock", () => {
  it("formats minutes and seconds, and hours when there are some", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(75_000)).toBe("1:15");
    expect(formatClock(2410_000)).toBe("40:10");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("trackStateSince", () => {
  it("keeps the instant while the state holds and restarts it on a change", () => {
    const first = trackStateSince(new Map(), [{ agentId: "a", state: "working" }], 100);
    const same = trackStateSince(first, [{ agentId: "a", state: "working" }], 200);
    expect(same.get("a")?.since).toBe(100);
    const changed = trackStateSince(same, [{ agentId: "a", state: "done" }], 300);
    expect(changed.get("a")).toEqual({ state: "done", since: 300 });
  });
  it("forgets an agent that left", () => {
    const first = trackStateSince(new Map(), [{ agentId: "a", state: "working" }], 100);
    expect(trackStateSince(first, [], 200).size).toBe(0);
  });
});

describe("cardLines", () => {
  const lines = (a: RoomAgent, live = 0) => cardLines(a, cardStatus(a, live));
  const report = (summary: string, at = 70_000, status: "done" | "failed" | "blocked" = "done") => ({ status, summary, artifacts: [], at });

  it("shows a running agent's activity as the live line, counting from its start", () => {
    expect(lines(agent({ startedAt: 1_000 }))).toEqual([{ text: null, tone: "now", at: "live" }]);
    // No start from the relay: no time to show, rather than a made-up one.
    expect(lines(agent())).toEqual([{ text: null, tone: "now" }]);
  });

  it("dates a question at when it was asked into the run", () => {
    const needsYou = [{ kind: "choice" as const, promptId: "q", askedAt: 46_000, count: 1 }];
    expect(lines(agent({ state: "awaiting_user", startedAt: 1_000, needsYou }))).toEqual([{ text: null, tone: "ask", at: 45_000 }]);
  });

  it("prints a finished agent's report, one line each, the first dated and toned by the outcome", () => {
    const done = agent({ state: "done", startedAt: 10_000, report: report("Measured 18 pairs\n\n4 fixes proposed\nsee notes\nmore") });
    expect(lines(done)).toEqual([
      { text: "Measured 18 pairs", tone: "past", at: 60_000 },
      { text: "4 fixes proposed", tone: "past" },
      { text: "see notes", tone: "past" },
    ]);
    const failed = agent({ state: "failed", startedAt: 10_000, report: report("Build broke", 70_000, "failed") });
    expect(lines(failed)[0]?.tone).toBe("fail");
  });

  it("lets the activity say a finished agent left no report", () => {
    expect(lines(agent({ state: "done" }))).toEqual([{ text: null, tone: "quiet" }]);
  });

  it("keeps an earlier turn's report above what the agent is doing again", () => {
    const again = agent({ state: "working", startedAt: 90_000, report: report("First pass\nSecond\nThird") });
    expect(lines(again)).toEqual([
      { text: "First pass", tone: "past" },
      { text: "Second", tone: "past" },
      { text: null, tone: "now", at: "live" },
    ]);
  });

  it("words a stopped agent quietly, with no time", () => {
    expect(lines(agent({ state: "stopped", startedAt: 1_000 }))).toEqual([{ text: null, tone: "quiet" }]);
  });
});
