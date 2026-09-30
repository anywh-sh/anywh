import { describe, expect, it } from "vitest";
import { getDictionary } from "@/i18n/dictionaries";
import type { LogEntry, ToolCallEntry } from "@/hooks/relay/useMessageLog";
import { buildTimeline, callMeta, callTarget, groupBatch, summarizeGroup } from "@/lib/format/activity";

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

  it("leaves tasks and plans out of groups, splitting the run around them", () => {
    const plan = call({ name: "plan", toolKind: "other", plan: [] });
    const task = call({ toolKind: "task", subject: { kind: "task", label: "explore" } });
    const items = buildTimeline([read("/a.ts"), plan, read("/b.ts"), task, read("/c.ts")]);
    expect(items.map((i) => i.kind)).toEqual(["group", "single", "group", "single", "group"]);
  });

  it("gives a group the id of its first call, stable as the group grows", () => {
    const first = read("/a.ts");
    const before = buildTimeline([first]);
    const after = buildTimeline([first, read("/b.ts")]);
    expect(before[0]).toMatchObject({ id: first.id });
    expect(after[0]).toMatchObject({ id: first.id });
  });
});

describe("summarizeGroup", () => {
  it("describes each call up to four, in the past for finished ones", () => {
    const s = summarizeGroup([read("/w/src/socket.ts"), shell("npm test")], en);
    expect(s.text).toBe("Read socket.ts, ran npm test");
    expect(s.running).toBe(false);
  });

  it("uses the gerund and an ellipsis for a call still running", () => {
    const s = summarizeGroup([read("/w/socket.ts"), shell("npm test", { done: false })], en);
    expect(s.text).toBe("Read socket.ts, running npm test…");
    expect(s.running).toBe(true);
  });

  it("collapses identical consecutive phrases into N×", () => {
    expect(summarizeGroup([shell("npm test"), shell("npm test")], en).text).toBe("Ran npm test 2×");
  });

  it("switches to counts by kind past four, in order of first appearance", () => {
    const calls = [shell("a"), read("/1"), read("/2"), read("/3"), read("/4"), shell("b"), shell("c")];
    expect(summarizeGroup(calls, en).text).toBe("Ran 3 commands, read 4 files");
  });

  it("lists what still runs after the counts", () => {
    const calls = [read("/1"), read("/2"), read("/3"), read("/4"), shell("npm test", { done: false })];
    expect(summarizeGroup(calls, en).text).toBe("Read 4 files, running npm test…");
  });

  it("counts calls in parallel batches of two or more, and failures", () => {
    const calls = [read("/a", { batchId: "m1" }), read("/b", { batchId: "m1" }), shell("x", { batchId: "m2" }), shell("y", { isError: true })];
    const s = summarizeGroup(calls, en);
    expect(s.parallel).toBe(2);
    expect(s.failed).toBe(1);
  });

  it("does not count a call the turn aborted as a failure", () => {
    expect(summarizeGroup([shell("x", { isError: true, aborted: true })], en).failed).toBe(0);
  });

  it("speaks the other language from the dictionary alone", () => {
    expect(summarizeGroup([read("/w/socket.ts"), shell("npm test")], pt).text).toBe("Leu socket.ts, rodou npm test");
  });

  it("falls back to the raw tool name when the runtime gave no subject", () => {
    const s = summarizeGroup([call({ name: "Mystery", toolKind: "other" })], en);
    expect(s.text).toBe("Used Mystery");
  });
});

describe("callTarget", () => {
  it("shortens each subject to what a sentence needs", () => {
    expect(callTarget(read("C:\\proj\\a.ts"))).toBe("a.ts");
    expect(callTarget(shell("ls -la\nmore"))).toBe("ls -la");
    expect(callTarget(call({ toolKind: "web", subject: { kind: "web", mode: "fetch", url: "https://x.dev/p?q=1" } }))).toBe("x.dev");
    expect(callTarget(call({ toolKind: "mcp", subject: { kind: "mcp", server: "linear", tool: "get" } }))).toBe("linear.get");
    expect(callTarget(shell("x".repeat(80))).endsWith("…")).toBe(true);
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
