import { describe, expect, it } from "vitest";
import { logTailLines, recentToolCallLines, runningSubagents } from "@/lib/format/backgroundActivity";
import type { LogEntry, SubagentState, ToolCallEntry } from "@/hooks/relay/useMessageLog";

function call(id: string, name: string, input: Record<string, unknown>, overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  const toolKind = name === "Agent" || name === "Task" ? "task" : name === "Bash" ? "shell" : "read";
  return { kind: "tool-call", id, toolUseId: id, name, toolKind, input, isError: false, done: false, ...overrides };
}

function subagent(overrides: Partial<SubagentState> = {}): SubagentState {
  return { toolUseId: "agent", status: "running", startedAt: 1000, background: true, toolCalls: [], ...overrides };
}

describe("runningSubagents", () => {
  it("lists running subagents from their own state, even once the spawning call has returned", () => {
    const entries: LogEntry[] = [
      { kind: "user", id: "u1", text: "go", sentAt: 1 },
      call("agent", "Agent", { description: "audit", run_in_background: true }, { done: true, content: "Async agent launched successfully." }),
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
      call("tu1", "Task", { description: "reviewing tests" }),
      call("tu2", "Agent", {}, { done: true, content: "done" }),
    ];
    expect(runningSubagents(entries, {}, null)).toEqual([
      { toolUseId: "tu1", description: "reviewing tests", startedAt: null, activity: null, toolCalls: [], toolUses: null },
    ]);
  });
});

describe("recentToolCallLines", () => {
  const entries: LogEntry[] = [
    call("old", "Bash", { command: "previous turn" }),
    { kind: "user", id: "u1", text: "go", sentAt: 1 },
    call("tu1", "Task", { description: "audit" }),
    call("tu2", "Read", { file_path: "/repo/src/app.ts" }),
    call("tu3", "Bash", { command: "npm test\n--watch" }),
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
