import { describe, expect, it } from "vitest";
import { logTailLines, recentToolCallLines, runningSubagents } from "@/lib/format/backgroundActivity";
import type { LogEntry, SubagentState } from "@/hooks/relay/useMessageLog";

function subagent(overrides: Partial<SubagentState> = {}): SubagentState {
  return { toolUseId: "agent", status: "running", startedAt: 1000, background: true, toolCalls: [], ...overrides };
}

describe("runningSubagents", () => {
  it("lists running subagents from their own state, even once the spawning call has returned", () => {
    const entries: LogEntry[] = [
      { kind: "user", id: "u1", text: "go", sentAt: 1 },
      { kind: "tool-use", id: "t1", toolUseId: "agent", name: "Agent", input: { description: "audit", run_in_background: true } },
      { kind: "tool-result", id: "r1", toolUseId: "agent", content: "Async agent launched successfully.", isError: false },
    ];
    const subagents = {
      agent: subagent({ description: "audit", toolUses: 2, toolCalls: [{ name: "Read", input: { file_path: "/repo/a.ts" } }] }),
      done: subagent({ toolUseId: "done", status: "completed" }),
    };

    expect(runningSubagents(entries, subagents, "/repo")).toEqual([
      { toolUseId: "agent", description: "audit", startedAt: 1000, activity: "Read a.ts", toolCalls: ["Read a.ts"], toolUses: 2 },
    ]);
  });

  it("prefers the CLI's own progress line over the latest tool call", () => {
    const subagents = { agent: subagent({ activity: "Reading a.txt", toolCalls: [{ name: "Read", input: { file_path: "/a.txt" } }] }) };
    expect(runningSubagents([], subagents, null)[0].activity).toBe("Reading a.txt");
  });

  it("falls back to an unanswered Agent/Task call when the relay sends no subagent state", () => {
    const entries: LogEntry[] = [
      { kind: "user", id: "u1", text: "go", sentAt: 1 },
      { kind: "tool-use", id: "t1", toolUseId: "tu1", name: "Task", input: { description: "reviewing tests" } },
      { kind: "tool-use", id: "t2", toolUseId: "tu2", name: "Agent", input: {} },
      { kind: "tool-result", id: "r2", toolUseId: "tu2", content: "done", isError: false },
    ];
    expect(runningSubagents(entries, {}, null)).toEqual([
      { toolUseId: "tu1", description: "reviewing tests", startedAt: null, activity: null, toolCalls: [], toolUses: null },
    ]);
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

});

describe("logTailLines", () => {
  it("keeps the last non-empty lines and collapses carriage-return progress", () => {
    expect(logTailLines("a\n\nb\n10%\r50%\r100%\n", 2)).toEqual(["b", "100%"]);
  });
});
