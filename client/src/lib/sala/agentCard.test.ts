import { describe, expect, it } from "vitest";
import type { RoomAgent } from "@/lib/relay/roomClient";
import { cardActivity, cardClock, cardStatus, firstLine, formatClock, progressSegments, runtimeTile, trackStateSince } from "@/lib/sala/agentCard";

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

  it("but a stop is final, whatever was left waiting", () => {
    const needsYou = [{ kind: "approval" as const, promptId: "q", count: 1 }];
    expect(cardStatus(agent({ state: "stopped", needsYou })).label).toBe("stopped");
  });
});

describe("cardActivity", () => {
  it("says a working principal coordinates its workers", () => {
    expect(cardActivity(agent({ role: "principal", state: "working" }), 3)).toEqual({ kind: "coordinating", agents: 3 });
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

describe("runtimeTile and progress", () => {
  it("names the runtimes the design draws and shortens the rest", () => {
    expect(runtimeTile("claude")).toBe("CC");
    expect(runtimeTile("codex")).toBe("CX");
    expect(runtimeTile("gemini")).toBe("GE");
  });
  it("lights the whole bar only for a finished agent", () => {
    expect(progressSegments("done").lit).toBeGreaterThan(0);
    expect(progressSegments("run")).toEqual({ lit: 0, live: true });
    expect(progressSegments("wait")).toEqual({ lit: 0, live: false });
  });
});
