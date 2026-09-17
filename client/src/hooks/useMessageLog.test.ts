import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useMessageLog, type LogEntry } from "@/hooks/useMessageLog";
import type { AgentEvent, HistoryMessage } from "@/lib/relay-types";

afterEach(() => {
  cleanup();
});

/** Strips the two volatile fields every real assertion below doesn't care
 * about the exact value of: `id` (`crypto.randomUUID()`, or a deterministic
 * `streaming-${index}` for a live preview) and `sentAt` (`Date.now()`). */
function stripVolatile(entries: LogEntry[]): unknown[] {
  return entries.map((entry) => {
    const { id: _id, ...rest } = entry;
    if ("sentAt" in rest) {
      const { sentAt: _sentAt, ...withoutSentAt } = rest;
      return withoutSentAt;
    }
    return rest;
  });
}

function agentEventPage(events: AgentEvent[]): HistoryMessage[] {
  return events.map((event) => ({ type: "agent_event", event }));
}

describe("useMessageLog", () => {
  it("addUserMessage appends a user entry with images", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.addUserMessage("oi", [{ id: "img-1" } as never]));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "user", text: "oi", images: [{ id: "img-1" }] }]);
  });

  it("handleEvent(text) commits a text entry", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "text", text: "hello!" }));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "text", text: "hello!", streaming: false }]);
  });

  it("drops the synthetic [Request interrupted...] marker instead of committing it as text", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "text", text: "[Request interrupted by user]" }));

    expect(result.current.entries).toEqual([]);
  });

  it("text_delta accumulates into streamingEntries, and a matching text commit clears it", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "text_delta", index: 0, text: "he" }));
    act(() => result.current.handleEvent({ type: "text_delta", index: 0, text: "llo" }));

    expect(stripVolatile(result.current.streamingEntries)).toEqual([{ kind: "text", text: "hello", streaming: true }]);

    act(() => result.current.handleEvent({ type: "text", text: "hello" }));

    expect(result.current.streamingEntries).toEqual([]);
    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "text", text: "hello", streaming: false }]);
  });

  it("tool_started then tool_ended produce a paired tool-use/tool-result entry", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "tool_started", toolUseId: "t1", name: "Bash", kind: "shell", input: { command: "ls" } }));
    act(() => result.current.handleEvent({ type: "tool_ended", toolUseId: "t1", content: "ok", isError: false }));

    expect(stripVolatile(result.current.entries)).toEqual([
      { kind: "tool-use", toolUseId: "t1", name: "Bash", input: { command: "ls" } },
      { kind: "tool-result", toolUseId: "t1", content: "ok", isError: false },
    ]);
  });

  it("tool_ended carries structuredPatch through to the tool-result entry", () => {
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }];
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "tool_ended", toolUseId: "t1", content: "ok", isError: false, structuredPatch: patch }));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "tool-result", toolUseId: "t1", content: "ok", isError: false, structuredPatch: patch }]);
  });

  it("plan (TodoWrite) folds back into a generic tool-use entry, not a dedicated widget", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() =>
      result.current.handleEvent({
        type: "plan",
        toolUseId: "t1",
        todos: [{ content: "write tests", status: "in_progress" }],
      }),
    );

    expect(stripVolatile(result.current.entries)).toEqual([
      { kind: "tool-use", toolUseId: "t1", name: "TodoWrite", input: { todos: [{ content: "write tests", status: "in_progress" }] } },
    ]);
  });

  it("a synthetic background_job user_message becomes a system note, never a user bubble", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "user_message", text: "...", synthetic: "background_job", label: "build finished" }));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "background-job-note", label: "build finished" }]);
  });

  it("a real user_message (from another device) becomes a user entry", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "user_message", text: "oi de outro device" }));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "user", text: "oi de outro device" }]);
  });

  it("session_id, usage, status, compact_boundary, thinking(_delta), tool_input_delta and tool_progress have no visual representation yet", () => {
    const { result } = renderHook(() => useMessageLog());
    const noopEvents: AgentEvent[] = [
      { type: "session_id", sessionId: "s1" },
      { type: "usage", inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      { type: "status", permissionMode: "acceptEdits" },
      { type: "compact_boundary", trigger: "auto", preTokens: 100 },
      { type: "thinking", thinking: "hmm" },
      { type: "thinking_delta", index: 0, thinking: "hm" },
      { type: "tool_input_delta", toolUseId: "t1", partialJson: "{" },
      { type: "tool_progress", toolUseId: "t1", text: "50%" },
      { type: "turn_started" },
    ];
    for (const event of noopEvents) act(() => result.current.handleEvent(event));

    expect(result.current.entries).toEqual([]);
    expect(result.current.streamingEntries).toEqual([]);
  });

  it("handleTurnComplete(true) flushes any live streaming text and appends a stopped note", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "text_delta", index: 0, text: "partial" }));
    act(() => result.current.handleTurnComplete(true));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "text", text: "partial", streaming: false }, { kind: "stopped" }]);
    expect(result.current.streamingEntries).toEqual([]);
  });

  it("handleTurnComplete(false) appends no stopped note", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "text", text: "done" }));
    act(() => result.current.handleTurnComplete(false));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "text", text: "done", streaming: false }]);
  });

  it("handleTurnError appends an error entry", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleTurnError("boom"));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "error", message: "boom" }]);
  });

  it("editUserMessage truncates entries at the target id and pushes the new text", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.addUserMessage("first", undefined));
    act(() => result.current.handleEvent({ type: "text", text: "reply" }));
    const targetId = result.current.entries[0].id;
    act(() => result.current.editUserMessage(targetId, "edited"));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "user", text: "edited" }]);
  });

  it("reset clears entries and pagination state back to initial", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "text", text: "hi" }));
    act(() => result.current.reset());

    expect(result.current.entries).toEqual([]);
    expect(result.current.hasMoreHistory).toBe(false);
    expect(result.current.historyCursor).toBeNull();
  });

  it("hydrate folds a full agent_event history page, including turn_ended closing the turn", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() =>
      result.current.hydrate({
        messages: agentEventPage([
          { type: "turn_started" },
          { type: "user_message", text: "oi" },
          { type: "text", text: "hello!" },
          { type: "turn_ended", stopped: false },
        ]),
        cursor: 0,
        hasMore: false,
      }),
    );

    expect(stripVolatile(result.current.entries)).toEqual([
      { kind: "user", text: "oi" },
      { kind: "text", text: "hello!", streaming: false },
    ]);
    expect(result.current.hasMoreHistory).toBe(false);
    expect(result.current.historyCursor).toBe(0);
  });

  it("prependHistory inserts an older page before what's already on screen, without touching live streamingText", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "text_delta", index: 0, text: "live" }));
    act(() =>
      result.current.prependHistory({
        messages: agentEventPage([{ type: "user_message", text: "old question" }, { type: "text", text: "old answer" }]),
        cursor: 0,
        hasMore: false,
      }),
    );

    expect(stripVolatile(result.current.entries)).toEqual([
      { kind: "user", text: "old question" },
      { kind: "text", text: "old answer", streaming: false },
    ]);
    // The in-progress live preview survives — prepending history operates on
    // a scratch state, never on `state.streamingText`.
    expect(stripVolatile(result.current.streamingEntries)).toEqual([{ kind: "text", text: "live", streaming: true }]);
  });
});
