import { describe, expect, it } from "vitest";
import { findRunningTaskCall, logTailLines, recentToolCallLines } from "@/lib/format/backgroundActivity";
import type { LogEntry } from "@/hooks/relay/useMessageLog";

describe("findRunningTaskCall", () => {
  it("finds a Task call with no matching tool-result yet", () => {
    const entries: LogEntry[] = [
      { kind: "user", id: "u1", text: "go", sentAt: 1 },
      { kind: "tool-use", id: "t1", toolUseId: "tu1", name: "Task", input: { description: "reviewing tests" } },
    ];
    expect(findRunningTaskCall(entries)).toEqual({ toolUseId: "tu1", description: "reviewing tests" });
  });

  it("returns undefined once the Task call's tool-result has arrived", () => {
    const entries: LogEntry[] = [
      { kind: "user", id: "u1", text: "go", sentAt: 1 },
      { kind: "tool-use", id: "t1", toolUseId: "tu1", name: "Task", input: {} },
      { kind: "tool-result", id: "r1", toolUseId: "tu1", content: "done", isError: false },
    ];
    expect(findRunningTaskCall(entries)).toBeUndefined();
  });

  it("ignores tool-use entries that are not Task", () => {
    const entries: LogEntry[] = [
      { kind: "user", id: "u1", text: "go", sentAt: 1 },
      { kind: "tool-use", id: "t1", toolUseId: "tu1", name: "Bash", input: { command: "ls" } },
    ];
    expect(findRunningTaskCall(entries)).toBeUndefined();
  });

  it("does not look past the most recent user message", () => {
    const entries: LogEntry[] = [
      { kind: "tool-use", id: "t1", toolUseId: "tu1", name: "Task", input: {} },
      { kind: "tool-result", id: "r1", toolUseId: "tu1", content: "done", isError: false },
      { kind: "user", id: "u2", text: "go again", sentAt: 2 },
    ];
    expect(findRunningTaskCall(entries)).toBeUndefined();
  });

  it("falls back to null when the Task call carries no description", () => {
    const entries: LogEntry[] = [{ kind: "tool-use", id: "t1", toolUseId: "tu1", name: "Task", input: {} }];
    expect(findRunningTaskCall(entries)).toEqual({ toolUseId: "tu1", description: null });
  });
});

describe("recentToolCallLines", () => {
  const entries: LogEntry[] = [
    { kind: "tool-use", id: "old", toolUseId: "old", name: "Bash", input: { command: "previous turn" } },
    { kind: "user", id: "u1", text: "go", sentAt: 1 },
    { kind: "tool-use", id: "t1", toolUseId: "tu1", name: "Task", input: { description: "audit" } },
    { kind: "tool-use", id: "t2", toolUseId: "tu2", name: "Read", input: { file_path: "/repo/src/app.ts" } },
    { kind: "tool-use", id: "t3", toolUseId: "tu3", name: "Bash", input: { command: "npm test\n--watch" } },
  ];

  it("lists the current turn's latest calls, oldest first, paths relative to cwd", () => {
    expect(recentToolCallLines(entries, "/repo", { limit: 2 })).toEqual(["Read src/app.ts", "Bash npm test"]);
  });

  it("stops at the given tool call, for a subagent's own calls", () => {
    expect(recentToolCallLines(entries, "/repo", { limit: 10, afterToolUseId: "tu1" })).toEqual([
      "Read src/app.ts",
      "Bash npm test",
    ]);
  });
});

describe("logTailLines", () => {
  it("keeps the last non-empty lines and collapses carriage-return progress", () => {
    expect(logTailLines("a\n\nb\n10%\r50%\r100%\n", 2)).toEqual(["b", "100%"]);
  });
});
