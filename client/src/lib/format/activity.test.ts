import { describe, expect, it } from "vitest";
import { getDictionary } from "@/i18n/dictionaries";
import type { LogEntry, ToolCallEntry } from "@/hooks/relay/useMessageLog";
import { buildTimeline, callDuration, callMeta, callTarget, groupBatch, groupDuration, groupStatus } from "@/lib/format/activity";

const en = getDictionary("en").chat.activity;
const pt = getDictionary("pt-BR").chat.activity;

let seq = 0;
function call(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  seq += 1;
  return { kind: "tool-call", id: `c${seq}`, toolUseId: `t${seq}`, name: "Bash", toolKind: "shell", input: {}, isError: false, done: true, ...overrides };
}
const read = (path: string, o: Partial<ToolCallEntry> = {}) => call({ toolKind: "read", subject: { kind: "read", path }, ...o });
const shell = (command: string, o: Partial<ToolCallEntry> = {}) => call({ subject: { kind: "shell", command }, ...o });
const text = (id: string): LogEntry => ({ kind: "text", id, text: "hi", streaming: false, sentAt: 0 });

describe("buildTimeline", () => {
  it("groups consecutive calls and breaks the group at text, reasoning and errors", () => {
    const a = read("/a.ts");
    const b = read("/b.ts");
    const c = shell("ls");
    const d = shell("pwd");
    const items = buildTimeline([a, b, text("x"), c, { kind: "thinking", id: "th", text: "", running: false }, d, { kind: "error", id: "e", message: "boom" }]);
    expect(items.map((i) => (i.kind === "group" ? i.calls.length : i.entry.kind))).toEqual([2, "text", 1, "thinking", 1, "error"]);
  });

  it("keeps a failed call inside its group", () => {
    const items = buildTimeline([read("/a.ts"), shell("false", { isError: true }), read("/b.ts")]);
    expect(items).toHaveLength(1);
  });

  it("leaves plans out of groups, splitting the run around them", () => {
    const plan = call({ name: "plan", toolKind: "other", plan: [] });
    const items = buildTimeline([read("/a.ts"), plan, read("/b.ts")]);
    expect(items.map((i) => i.kind)).toEqual(["group", "single", "group"]);
  });

  describe("a delegated task", () => {
    const task = (o: Partial<ToolCallEntry> = {}) => call({ name: "Agent", toolKind: "task", subject: { kind: "task", label: "explore" }, ...o });
    const kinds = (entries: LogEntry[], spawned: string[] = []) => buildTimeline(entries, new Set(spawned)).map((i) => (i.kind === "group" ? i.calls.length : i.kind));

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
      expect(kinds([read("/a.ts"), hidden, read("/b.ts")], ["a"])).toEqual([2]);
      const shown = task({ toolUseId: "b", isError: true });
      expect(kinds([read("/a.ts"), shown, read("/b.ts")])).toEqual([1, "single", 1]);
    });

    it("leaves every other call alone: only a task kind is ever dropped", () => {
      const others = [read("/a.ts"), shell("ls"), call({ toolKind: "mcp", subject: { kind: "mcp", server: "s", tool: "t" } }), call({ toolKind: "other", subject: { kind: "other", label: "x" } })];
      expect(kinds(others, others.map((o) => o.toolUseId as string))).toEqual([4]);
    });
  });

  it("gives a group the id of its first call, stable as the group grows", () => {
    const first = read("/a.ts");
    const before = buildTimeline([first]);
    const after = buildTimeline([first, read("/b.ts")]);
    expect(before[0]).toMatchObject({ id: first.id });
    expect(after[0]).toMatchObject({ id: first.id });
  });
});

describe("groupStatus", () => {
  it("counts every call, running or not", () => {
    expect(groupStatus([read("/a"), shell("ls"), shell("npm test", { done: false })])).toEqual({ count: 3, running: true, failed: 0 });
  });

  it("is not running once every call is done, and counts failures", () => {
    const status = groupStatus([read("/a"), shell("x", { isError: true }), shell("y", { isError: true })]);
    expect(status).toEqual({ count: 3, running: false, failed: 2 });
  });

  it("does not count a call the turn aborted as a failure", () => {
    expect(groupStatus([shell("x", { isError: true, aborted: true })]).failed).toBe(0);
  });
});

describe("the group line", () => {
  // The line is `toolsRunning`/`toolsUsed` with `{count}` filled in: a pair per
  // language, and a placeholder in the plural form is what keeps the number
  // from being lost in translation.
  it.each([
    ["en", en],
    ["pt-BR", pt],
  ])("has a singular and a counted plural, both ways, in %s", (_, dict) => {
    for (const pair of [dict.toolsRunning, dict.toolsUsed]) {
      expect(pair.one).not.toContain("{count}");
      expect(pair.many).toContain("{count}");
    }
  });
});

describe("groupDuration", () => {
  const timed = (startedAt: number, endedAt: number, o: Partial<ToolCallEntry> = {}) => shell("x", { startedAt, endedAt, ...o });

  it("runs from the first start to the last end, so parallel calls are not added twice", () => {
    expect(groupDuration([timed(1000, 4000), timed(1000, 3000), timed(5000, 6500)])).toBe(5500);
  });

  it("is unknown while any call is still open", () => {
    expect(groupDuration([timed(1000, 2000), shell("y", { done: false, startedAt: 2000 })])).toBeUndefined();
  });

  it("is unknown when a call has no timestamps — an older replay — rather than guessed", () => {
    expect(groupDuration([timed(1000, 2000), shell("y")])).toBeUndefined();
    expect(groupDuration([])).toBeUndefined();
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

describe("groupBatch", () => {
  it("is a batch only when the whole group shares one id", () => {
    expect(groupBatch([read("/a", { batchId: "m" }), read("/b", { batchId: "m" })])?.count).toBe(2);
    expect(groupBatch([read("/a", { batchId: "m" }), read("/b", { batchId: "n" })])).toBeUndefined();
    expect(groupBatch([read("/a", { batchId: "m" })])).toBeUndefined();
  });

  it("measures the batch from the first start to the last end, once it is over", () => {
    const calls = [read("/a", { batchId: "m", startedAt: 1000, endedAt: 2500 }), read("/b", { batchId: "m", startedAt: 1100, endedAt: 3000 })];
    expect(groupBatch(calls)?.durationMs).toBe(2000);
    expect(groupBatch([...calls.slice(0, 1), { ...calls[1], done: false }])?.durationMs).toBeUndefined();
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
