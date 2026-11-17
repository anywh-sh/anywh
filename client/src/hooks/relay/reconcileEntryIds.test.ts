import { describe, expect, it } from "vitest";
import { reconcileEntryIds } from "./reconcileEntryIds";
import type { LogEntry } from "./useMessageLog";

const user = (id: string, text: string, sentAt = 1): LogEntry => ({ kind: "user", id, text, sentAt });
const text = (id: string, body: string): LogEntry => ({ kind: "text", id, text: body, streaming: false, sentAt: 1 });
const tool = (id: string, toolUseId: string): LogEntry => ({
  kind: "tool-call",
  id,
  toolUseId,
  name: "Bash",
  toolKind: "other",
  input: {},
  isError: false,
  done: true,
});
const footer = (id: string, body: string): LogEntry => ({ kind: "turn-footer", id, sentAt: 1, text: body });
const ids = (entries: LogEntry[]) => entries.map((entry) => entry.id);

describe("reconcileEntryIds", () => {
  const prev = [user("u1", "hi"), tool("t1", "call-1"), text("a1", "hello"), footer("f1", "hello")];

  it("keeps every id when the same history is folded again", () => {
    const next = [user("x1", "hi"), tool("x2", "call-1"), text("x3", "hello"), footer("x4", "hello")];
    expect(ids(reconcileEntryIds(prev, next))).toEqual(["u1", "t1", "a1", "f1"]);
  });

  it("matches a user message by text, not by the time it was sent", () => {
    const next = [user("x1", "hi", 999)];
    expect(ids(reconcileEntryIds(prev, next))).toEqual(["u1"]);
  });

  it("keeps old ids and mints new ones only for what is new", () => {
    const next = [...prev.map((entry) => ({ ...entry, id: `n-${entry.id}` })), user("n-u2", "more"), text("n-a2", "sure")];
    expect(ids(reconcileEntryIds(prev, next))).toEqual(["u1", "t1", "a1", "f1", "n-u2", "n-a2"]);
  });

  it("keeps only the unchanged part when the history was edited", () => {
    const next = [user("x1", "hi"), tool("x2", "call-1"), text("x3", "a different answer"), footer("x4", "a different answer")];
    expect(ids(reconcileEntryIds(prev, next))).toEqual(["u1", "t1", "x3", "x4"]);
  });

  it("pairs repeated content in order", () => {
    const before = [text("a", "ok"), text("b", "ok"), text("c", "ok")];
    const after = [text("x", "ok"), text("y", "ok")];
    expect(ids(reconcileEntryIds(before, after))).toEqual(["a", "b"]);
  });

  it("gives an id to one entry only once", () => {
    const before = [text("a", "ok")];
    const after = [text("x", "ok"), text("y", "ok")];
    expect(ids(reconcileEntryIds(before, after))).toEqual(["a", "y"]);
  });

  it("returns next untouched when there is nothing to reconcile with", () => {
    const next = [user("x1", "hi")];
    expect(reconcileEntryIds([], next)).toBe(next);
  });
});
