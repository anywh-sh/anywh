import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "@/hooks/relay/useMessageLog";
import { botActivityOf } from "@/lib/bots/botActivity";

const call = (tool: string, input: Record<string, unknown>, over: Partial<ToolCallEntry> = {}): ToolCallEntry => ({
  kind: "tool-call",
  id: "c",
  name: `mcp__anywh-room__${tool}`,
  toolKind: "mcp",
  input,
  subject: { kind: "mcp", server: "anywh-room", tool },
  isError: false,
  done: true,
  ...over,
});

describe("botActivityOf", () => {
  it("reads the bot's own tools as lines, with the task's number", () => {
    expect(botActivityOf(call("task_create", { title: "Fix CI" }, { content: '{"task":12}' }))).toEqual({ kind: "created", n: 12, text: "Fix CI" });
    expect(botActivityOf(call("task_update", { task: 12, status: "working" }))).toEqual({ kind: "updated", n: 12 });
    expect(botActivityOf(call("task_ask", { task: "#13", question: "Retry?", options: ["a"] }))).toEqual({ kind: "asked", n: 13, text: "Retry?" });
    expect(botActivityOf(call("remember", { kind: "rule", text: "Never merge" }))).toEqual({ kind: "remembered", text: "Never merge" });
    expect(botActivityOf(call("schedule_create", { name: "Hourly", cron: "0 * * * *", prompt: "p" }))).toEqual({ kind: "scheduled", text: "Hourly" });
  });

  it("reads the calls to other bots as lines naming the bot", () => {
    expect(botActivityOf(call("bot_list", {}))).toEqual({ kind: "peers" });
    expect(botActivityOf(call("bot_ask", { to: "Release", question: "What shipped?" }))).toEqual({ kind: "askedBot", name: "Release", text: "What shipped?" });
    expect(botActivityOf(call("bot_handoff", { to: "Fixer", title: "Fix it", details: "d" }))).toEqual({ kind: "handedOff", name: "Fixer", text: "Fix it" });
    expect(botActivityOf(call("bot_ask", { question: "q" })), "no bot named").toBeUndefined();
    expect(botActivityOf(call("bot_ask", { to: "Release", question: "q" }, { isError: true }))).toBeUndefined();
  });

  it("leaves everything else where the log draws it", () => {
    expect(botActivityOf(call("delegate", { name: "Fixer", task: "x" })), "a room's delegate, without a task").toBeUndefined();
    expect(botActivityOf(call("delegate", { name: "Fixer", task: "x", task_number: 2 }))).toEqual({ kind: "delegated", n: 2, text: "Fixer" });
    expect(botActivityOf(call("task_create", { title: "x" }, { isError: true, content: "too many" }))).toBeUndefined();
    expect(botActivityOf(call("task_update", { task: 1 }, { done: false }))).toBeUndefined();
    expect(botActivityOf({ ...call("remember", { text: "x" }), subject: { kind: "mcp", server: "other", tool: "remember" } })).toBeUndefined();
  });
});
