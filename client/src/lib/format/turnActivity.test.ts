import { describe, expect, it } from "vitest";
import { countToolCallsInCurrentTurn } from "./turnActivity";
import type { LogEntry } from "@/hooks/relay/useMessageLog";

const user = (id: string): LogEntry => ({ kind: "user", id, text: "hi", sentAt: 0 });
const tool = (id: string): LogEntry => ({ kind: "tool-use", id, name: "Read", input: {} });
const text = (id: string): LogEntry => ({ kind: "text", id, text: "ok", streaming: false, sentAt: 0 });

describe("countToolCallsInCurrentTurn", () => {
  it("counts the tools reached for since the user last spoke", () => {
    expect(countToolCallsInCurrentTurn([user("u1"), tool("t1"), text("a1"), tool("t2")])).toBe(2);
  });

  // The count is about the wait happening now — a previous turn's tools
  // already have their answer on screen.
  it("stops at the previous turn", () => {
    expect(countToolCallsInCurrentTurn([user("u1"), tool("t1"), tool("t2"), user("u2"), tool("t3")])).toBe(1);
  });

  it("is zero before the agent has called anything", () => {
    expect(countToolCallsInCurrentTurn([user("u1"), text("a1")])).toBe(0);
  });

  it("is zero on an empty log", () => {
    expect(countToolCallsInCurrentTurn([])).toBe(0);
  });
});
