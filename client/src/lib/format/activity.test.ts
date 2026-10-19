import { describe, expect, it } from "vitest";
import { getDictionary } from "@/i18n/dictionaries";
import type { LogEntry, ToolCallEntry } from "@/hooks/relay/useMessageLog";
import { buildTimeline, callDuration, callMeta, callTarget, callTargetChip, failureLine, type TimelineItem, type WorkItem } from "@/lib/format/activity";

const en = getDictionary("en").chat.activity;
const pt = getDictionary("pt-BR").chat.activity;

let seq = 0;
function call(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  seq += 1;
  return { kind: "tool-call", id: `c${seq}`, toolUseId: `t${seq}`, name: "Bash", toolKind: "shell", input: {}, isError: false, done: true, ...overrides };
}
const read = (path: string, o: Partial<ToolCallEntry> = {}) => call({ toolKind: "read", subject: { kind: "read", path }, ...o });
const shell = (command: string, o: Partial<ToolCallEntry> = {}) => call({ subject: { kind: "shell", command }, ...o });
const text = (id: string, body = "hi"): LogEntry => ({ kind: "text", id, text: body, streaming: false, sentAt: 0 });
const thinking = (id: string, o: Partial<Extract<LogEntry, { kind: "thinking" }>> = {}): LogEntry => ({ kind: "thinking", id, text: "", running: false, ...o });
const user = (id: string): LogEntry => ({ kind: "user", id, text: "go", sentAt: 0 });
const footer = (id: string, durationMs?: number): LogEntry => ({ kind: "turn-footer", id, sentAt: 0, text: "", ...(durationMs !== undefined ? { durationMs } : {}) });
const works = (items: TimelineItem[]): WorkItem[] => items.filter((item): item is WorkItem => item.kind === "work");
/** `work:<steps>` / the single's entry kind, to read a timeline at a glance. */
const shape = (items: TimelineItem[]) => items.map((item) => (item.kind === "work" ? `work:${item.steps.map((step) => (step.kind === "think" ? "think" : step.calls.length)).join("+")}` : item.entry.kind));

describe("buildTimeline", () => {
  it("draws a turn's reasoning and calls as one block, however they interleave", () => {
    const items = buildTimeline([user("u"), thinking("t1", { text: "plan" }), read("/a.ts"), thinking("t2", { text: "again" }), shell("ls"), text("answer"), footer("f", 9000)]);
    expect(shape(items)).toEqual(["user", "work:think+1+think+1", "text", "turn-footer"]);
  });

  it("keeps the answer outside and takes the remarks before more activity in as steps", () => {
    const items = buildTimeline([user("u"), text("a", "Let me read it first."), read("/a.ts"), text("b", "Now the tests."), shell("npm test"), text("c", "All green."), footer("f")]);
    expect(shape(items)).toEqual(["user", "work:think+1+think+1", "text", "turn-footer"]);
    expect(items[2]).toMatchObject({ entry: { id: "c" } });
  });

  it("is not a block when the turn is only an answer", () => {
    expect(shape(buildTimeline([user("u"), text("a"), footer("f")]))).toEqual(["user", "text", "turn-footer"]);
  });

  it("merges calls of the same kind in a row into one step, and not different ones", () => {
    const items = buildTimeline([read("/a.ts"), read("/b.ts"), read("/c.ts"), shell("ls"), read("/d.ts")]);
    expect(shape(items)).toEqual(["work:3+1+1"]);
  });

  it("leaves out reasoning that said nothing, but still counts its time", () => {
    const [block] = works(buildTimeline([user("u"), thinking("t", { startedAt: 1000, endedAt: 4000 }), read("/a.ts", { startedAt: 4000, endedAt: 6000 }), footer("f")]));
    expect(block.steps).toHaveLength(1);
    expect(block.startedAt).toBe(1000);
    expect(block.durationMs).toBe(5000);
  });

  it("counts the failures, and a retry that worked does not take one back", () => {
    const [block] = works(buildTimeline([shell("npm test", { isError: true }), shell("npm test"), read("/a.ts", { isError: true, aborted: true })]));
    expect(block.failed).toBe(1);
    expect(block.steps[0]).toMatchObject({ kind: "tool", failed: true });
  });

  it("runs until its turn ends, and only the latest block of an open turn", () => {
    expect(works(buildTimeline([user("u"), read("/a.ts")]))[0].running).toBe(true);
    expect(works(buildTimeline([user("u"), read("/a.ts"), text("a"), footer("f")]))[0].running).toBe(false);
    const plan = call({ name: "plan", toolKind: "other", plan: [] });
    const [first, second] = works(buildTimeline([user("u"), read("/a.ts"), plan, read("/b.ts")]));
    expect([first.running, second.running]).toEqual([false, true]);
  });

  it("marks a turn cut short by a stop or an error, not a finished one", () => {
    expect(works(buildTimeline([user("u"), read("/a.ts"), { kind: "stopped", id: "s" }, footer("f")]))[0]).toMatchObject({ running: false, interrupted: true });
    expect(works(buildTimeline([user("u"), read("/a.ts"), { kind: "error", id: "e", message: "boom" }]))[0]).toMatchObject({ running: false, interrupted: true });
    expect(works(buildTimeline([user("u"), read("/a.ts"), text("a"), footer("f")]))[0].interrupted).toBe(false);
  });

  it("opens a block for a turn that has only started reasoning, with its clock", () => {
    const [block] = works(buildTimeline([user("u"), thinking("t", { running: true, pending: true, startedAt: 500 })]));
    expect(block).toMatchObject({ running: true, steps: [], startedAt: 500 });
  });

  it("falls back to the turn's own duration when a replay carries no timestamps", () => {
    const [block] = works(buildTimeline([user("u"), read("/a.ts"), text("a"), footer("f", 12_000)]));
    expect(block.durationMs).toBe(12_000);
    expect(works(buildTimeline([user("u"), read("/a.ts")]))[0].durationMs).toBeUndefined();
  });

  it("gives each turn its own block", () => {
    const items = buildTimeline([user("u1"), read("/a.ts"), text("a"), footer("f1"), user("u2"), shell("ls"), text("b"), footer("f2")]);
    expect(shape(items)).toEqual(["user", "work:1", "text", "turn-footer", "user", "work:1", "text", "turn-footer"]);
  });

  it("splits at an error and at a plan, so the turn reads in order around them", () => {
    const plan = call({ name: "plan", toolKind: "other", plan: [] });
    expect(shape(buildTimeline([read("/a.ts"), plan, read("/b.ts")]))).toEqual(["work:1", "tool-call", "work:1"]);
    expect(shape(buildTimeline([read("/a.ts"), { kind: "error", id: "e", message: "boom" }, read("/b.ts")]))).toEqual(["work:1", "error", "work:1"]);
  });

  describe("a delegated task", () => {
    const task = (o: Partial<ToolCallEntry> = {}) => call({ name: "Agent", toolKind: "task", subject: { kind: "task", label: "explore" }, ...o });
    const kinds = (entries: LogEntry[], spawned: string[] = []) => buildTimeline(entries, new Set(spawned)).map((i) => (i.kind === "work" ? i.steps.length : i.kind));

    it("is not drawn while it runs: the subagent card is its one representation", () => {
      expect(kinds([task({ done: false, toolUseId: "a" })])).toEqual([]);
      expect(kinds([task({ done: false, toolUseId: "a" })], ["a"])).toEqual([]);
    });

    it("is not drawn once it ended well with a subagent behind it", () => {
      expect(kinds([task({ toolUseId: "a" })], ["a"])).toEqual([]);
    });

    it("is drawn when it failed — a spawn error has no subagent and its message is the only explanation", () => {
      expect(kinds([task({ toolUseId: "a", isError: true, content: "Cannot create agent worktree" })])).toEqual(["single"]);
      expect(kinds([task({ toolUseId: "a", isError: true })], ["a"])).toEqual(["single"]);
    });

    it("is drawn when it ended without the CLI ever reporting a subagent for it", () => {
      expect(kinds([task({ toolUseId: "a" })])).toEqual(["single"]);
      expect(kinds([task({ toolUseId: undefined })])).toEqual(["single"]);
    });

    it("is drawn when the turn was stopped before any subagent was reported, not when one was", () => {
      expect(kinds([task({ toolUseId: "a", aborted: true, isError: true })])).toEqual(["single"]);
      expect(kinds([task({ toolUseId: "a", aborted: true, isError: true })], ["a"])).toEqual([]);
    });

    it("neither joins nor splits a run when hidden, and ends it like any card when shown", () => {
      const hidden = task({ toolUseId: "a" });
      expect(kinds([read("/a.ts"), hidden, shell("ls")], ["a"])).toEqual([2]);
      const shown = task({ toolUseId: "b", isError: true });
      expect(kinds([read("/a.ts"), shown, read("/b.ts")])).toEqual([1, "single", 1]);
    });

    it("leaves every other call alone: only a task kind is ever dropped", () => {
      const others = [read("/a.ts"), shell("ls"), call({ toolKind: "mcp", subject: { kind: "mcp", server: "s", tool: "t" } }), call({ toolKind: "other", subject: { kind: "other", label: "x" } })];
      expect(kinds(others, others.map((o) => o.toolUseId as string))).toEqual([4]);
    });
  });

  it("gives a block the id of its first entry, stable as it grows", () => {
    const first = read("/a.ts");
    const before = buildTimeline([first]);
    const after = buildTimeline([first, read("/b.ts"), shell("ls")]);
    expect(before[0]).toMatchObject({ id: first.id });
    expect(after[0]).toMatchObject({ id: first.id });
  });
});

describe("the work block's words", () => {
  // `{time}` and `{count}` are what keeps a number from being lost in translation.
  it.each([
    ["en", en],
    ["pt-BR", pt],
  ])("fills its time and its count, and has a verb in both tenses for every kind of call, in %s", (_, dict) => {
    expect(dict.work.workedFor).toContain("{time}");
    expect(dict.work.failedMany).toContain("{count}");
    expect(dict.work.moreTargets).toContain("{count}");
    for (const verb of Object.values(dict.work.steps)) {
      expect(verb.past).not.toBe("");
      expect(verb.ing).not.toBe("");
      expect(verb.past).not.toBe(verb.ing);
    }
  });
});

describe("callDuration", () => {
  it("needs both timestamps, and never goes negative on a skewed clock", () => {
    expect(callDuration(shell("x", { startedAt: 1000, endedAt: 1420 }))).toBe(420);
    expect(callDuration(shell("x", { startedAt: 1000 }))).toBeUndefined();
    expect(callDuration(shell("x", { startedAt: 2000, endedAt: 1000 }))).toBe(0);
  });
});

describe("callTarget", () => {
  it("shortens each subject to what a sentence needs", () => {
    expect(callTarget(read("C:\\proj\\a.ts"))).toBe("a.ts");
    expect(callTarget(shell("ls -la\nmore"))).toBe("ls -la");
    expect(callTarget(call({ toolKind: "web", subject: { kind: "web", mode: "fetch", url: "https://x.dev/p?q=1" } }))).toBe("x.dev");
    expect(callTarget(call({ toolKind: "mcp", subject: { kind: "mcp", server: "linear", tool: "get" } }))).toBe("linear.get");
    expect(callTarget(shell("x".repeat(80))).endsWith("…")).toBe(true);
    // A runtime that gave no subject: the raw tool name, never an empty target.
    expect(callTarget(call({ name: "Mystery", toolKind: "other" }))).toBe("Mystery");
  });
});

describe("callTargetChip", () => {
  it("names what each call acted on, with the whole text kept for the tooltip", () => {
    expect(callTargetChip(read("/w/src/MessageLog.tsx"))).toMatchObject({ kind: "file", label: "MessageLog.tsx", full: "/w/src/MessageLog.tsx" });
    expect(callTargetChip(shell("npm test\nmore"))).toMatchObject({ kind: "command", label: "npm test", full: "npm test\nmore" });
    expect(callTargetChip(call({ toolKind: "web", subject: { kind: "web", mode: "fetch", url: "https://x.dev/p?q=1" } }))).toMatchObject({ kind: "domain", label: "x.dev" });
    expect(callTargetChip(call({ toolKind: "web", subject: { kind: "web", mode: "search", query: "tauri ios" } }))).toMatchObject({ kind: "query", label: "tauri ios" });
    expect(callTargetChip(call({ toolKind: "mcp", subject: { kind: "mcp", server: "linear", tool: "get" } }))).toMatchObject({ kind: "app", label: "linear.get" });
    expect(callTargetChip(call({ name: "Mystery", toolKind: "other" }))).toMatchObject({ kind: "other", label: "Mystery" });
  });

  it("carries the change on an edit", () => {
    const edit = call({ toolKind: "edit", subject: { kind: "edit", path: "/a.ts" }, outcome: { kind: "diff", path: "/a.ts", hunks: [], added: 9, removed: 2 } });
    expect(callTargetChip(edit).diff).toEqual({ added: 9, removed: 2 });
  });
});

describe("failureLine", () => {
  it("is the first useful line of a failure, and nothing for a call that did not fail", () => {
    expect(failureLine(shell("x", { isError: true, content: "\n  Error: nope\nat x" }))).toBe("Error: nope");
    expect(failureLine(shell("x", { content: "fine" }))).toBe("");
    expect(failureLine(shell("x", { isError: true, aborted: true, content: "stopped" }))).toBe("");
    expect(failureLine(shell("x", { isError: true }))).toBe("");
  });
});

describe("callMeta", () => {
  it("reports only what the result says", () => {
    expect(callMeta(read("/a", { outcome: { kind: "code", path: "/a", lines: ["1", "2"] } }), en)).toEqual({ kind: "text", text: "2 lines" });
    expect(callMeta(call({ outcome: { kind: "files", paths: ["a"], total: 11 } }), en)).toEqual({ kind: "text", text: "11 files" });
    expect(callMeta(call({ outcome: { kind: "matches", matches: [{ path: "a", text: "x" }] } }), en)).toEqual({ kind: "text", text: "1 match" });
    expect(callMeta(call({ outcome: { kind: "diff", path: "/a", hunks: [], added: 5, removed: 1 } }), en)).toEqual({ kind: "diff", added: 5, removed: 1 });
  });

  it("shows the exit code of a failed command, and nothing when the runtime gave none", () => {
    const failed = { kind: "terminal" as const, output: "", exitCode: 2 };
    expect(callMeta(shell("x", { isError: true, outcome: failed }), en)).toEqual({ kind: "error", text: "exit 2" });
    expect(callMeta(shell("x", { isError: true, outcome: { kind: "terminal", output: "" } }), en)).toBeUndefined();
    expect(callMeta(shell("x", { outcome: failed }), en)).toBeUndefined();
  });

  it("has nothing to say for a call with no outcome", () => {
    expect(callMeta(shell("x"), en)).toBeUndefined();
  });
});
