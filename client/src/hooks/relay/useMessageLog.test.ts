import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useMessageLog, type LogEntry } from "@/hooks/relay/useMessageLog";
import type { AgentEvent, HistoryMessage } from "@/lib/relay/relay-types";

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

  it("tool_started then tool_ended fold into one tool-call entry, in place", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() =>
      result.current.handleEvent({
        type: "tool_started",
        toolUseId: "t1",
        name: "Bash",
        kind: "shell",
        input: { command: "ls" },
        subject: { kind: "shell", command: "ls" },
        startedAt: 1000,
        batchId: "m1",
      }),
    );
    expect(stripVolatile(result.current.entries)).toEqual([
      { kind: "tool-call", toolUseId: "t1", name: "Bash", toolKind: "shell", input: { command: "ls" }, subject: { kind: "shell", command: "ls" }, isError: false, done: false, startedAt: 1000, batchId: "m1" },
    ]);

    act(() => result.current.handleEvent({ type: "tool_ended", toolUseId: "t1", content: "ok", isError: false, outcome: { kind: "terminal", output: "ok" }, endedAt: 2500 }));
    expect(stripVolatile(result.current.entries)).toEqual([
      {
        kind: "tool-call",
        toolUseId: "t1",
        name: "Bash",
        toolKind: "shell",
        input: { command: "ls" },
        subject: { kind: "shell", command: "ls" },
        isError: false,
        done: true,
        content: "ok",
        outcome: { kind: "terminal", output: "ok" },
        startedAt: 1000,
        endedAt: 2500,
        batchId: "m1",
      },
    ]);
  });

  it("a result pairs with its own call even when calls run in parallel and finish out of order", () => {
    const { result } = renderHook(() => useMessageLog());
    for (const id of ["a", "b"]) act(() => result.current.handleEvent({ type: "tool_started", toolUseId: id, name: "Read", kind: "read", input: {} }));
    act(() => result.current.handleEvent({ type: "tool_ended", toolUseId: "b", content: "B", isError: true }));

    const [a, b] = result.current.entries;
    expect(a).toMatchObject({ toolUseId: "a", done: false });
    expect(b).toMatchObject({ toolUseId: "b", done: true, content: "B", isError: true });
  });

  it("a result with no matching call is dropped", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "tool_ended", toolUseId: "ghost", content: "ok", isError: false }));
    expect(result.current.entries).toEqual([]);
  });

  it("a plan becomes a tool-call carrying its todos, closed by its own ack", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "plan", toolUseId: "t1", todos: [{ content: "write tests", status: "in_progress" }] }));
    act(() => result.current.handleEvent({ type: "tool_ended", toolUseId: "t1", content: "ok", isError: false }));

    expect(result.current.entries[0]).toMatchObject({ kind: "tool-call", plan: [{ content: "write tests", status: "in_progress" }], done: true });
  });

  it("thinking_started opens a running block that the committed thinking closes, keeping its start", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "thinking_started", startedAt: 100 }));
    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "thinking", text: "", running: true, startedAt: 100 }]);

    act(() => result.current.handleEvent({ type: "thinking", thinking: "hmm", startedAt: 100, endedAt: 4100 }));
    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "thinking", text: "hmm", running: false, startedAt: 100, endedAt: 4100 }]);
  });

  it("a thinking block never announced (a replay) is added already finished", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "thinking", thinking: "", startedAt: 1, endedAt: 3001 }));
    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "thinking", text: "", running: false, startedAt: 1, endedAt: 3001 }]);
  });

  it("a turn that ends with calls and reasoning still open closes them instead of leaving them spinning", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "thinking_started" }));
    act(() => result.current.handleEvent({ type: "tool_started", toolUseId: "t1", name: "Bash", kind: "shell", input: {} }));
    act(() => result.current.handleTurnComplete(true));

    const [thinking, call] = result.current.entries;
    expect(thinking).toMatchObject({ kind: "thinking", running: false });
    expect(call).toMatchObject({ kind: "tool-call", done: true, aborted: true });
  });

  it("a finished turn gets a footer with its duration and everything the agent said", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "user_message", text: "go" }));
    act(() => result.current.handleEvent({ type: "text", text: "first" }));
    act(() => result.current.handleEvent({ type: "text", text: "second" }));
    act(() => result.current.handleTurnComplete(false, 12_000));

    const footer = result.current.entries[result.current.entries.length - 1];
    expect(footer).toMatchObject({ kind: "turn-footer", durationMs: 12_000, text: "first\n\nsecond" });
  });

  it("the footer covers only its own turn's text", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "user_message", text: "one" }));
    act(() => result.current.handleEvent({ type: "text", text: "A" }));
    act(() => result.current.handleTurnComplete(false, 1000));
    act(() => result.current.handleEvent({ type: "user_message", text: "two" }));
    act(() => result.current.handleEvent({ type: "text", text: "B" }));
    act(() => result.current.handleTurnComplete(false, 2000));

    expect(result.current.entries[result.current.entries.length - 1]).toMatchObject({ kind: "turn-footer", text: "B", durationMs: 2000 });
  });

  it("a turn that put nothing on screen gets no footer", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleTurnComplete(false, 500));
    expect(result.current.entries).toEqual([]);
  });

  it("a synthetic background_job user_message becomes a system note, never a user bubble", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "user_message", text: "...", synthetic: "background_job", label: "build finished" }));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "background-job-note", label: "build finished" }]);
  });

  it("a synthetic wakeup user_message becomes a system note, never a user bubble", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "user_message", text: "keep going on the loop task", synthetic: "wakeup" }));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "wakeup-note" }]);
  });

  it("a real user_message (from another device) becomes a user entry", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "user_message", text: "oi de outro device" }));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "user", text: "oi de outro device" }]);
  });

  it("session_id, usage, status, compact_boundary, thinking_delta, tool_input_delta and tool_progress have no visual representation yet", () => {
    const { result } = renderHook(() => useMessageLog());
    const noopEvents: AgentEvent[] = [
      { type: "session_id", sessionId: "s1" },
      { type: "usage", inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, prefixTokens: 1, outputTokens: 1 },
      { type: "status", permissionMode: "acceptEdits" },
      { type: "compact_boundary", trigger: "auto", preTokens: 100 },
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

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "text", text: "partial", streaming: false }, { kind: "stopped" }, { kind: "turn-footer", text: "partial" }]);
    expect(result.current.streamingEntries).toEqual([]);
  });

  it("handleTurnComplete(false) appends no stopped note", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "text", text: "done" }));
    act(() => result.current.handleTurnComplete(false));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "text", text: "done", streaming: false }, { kind: "turn-footer", text: "done" }]);
  });

  it("handleTurnError appends an error entry", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleTurnError("boom"));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "error", message: "boom" }]);
  });

  it("context_attribution updates attributionByToolUseId, never entries — it isn't a message", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "context_attribution", toolUseIds: ["t1"], tokens: 13_472, estimated: false }));

    expect(result.current.attributionByToolUseId).toEqual({ t1: { tokens: 13_472, estimated: false } });
    expect(result.current.entries).toEqual([]);
  });

  it("context_attribution with more than one toolUseId sets the same entry for each — the wire shape allows it even though nothing synthesizes it that way today", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "context_attribution", toolUseIds: ["t1", "t2"], tokens: 100, estimated: true }));

    expect(result.current.attributionByToolUseId).toEqual({
      t1: { tokens: 100, estimated: true },
      t2: { tokens: 100, estimated: true },
    });
  });

  it("a later context_attribution for the same toolUseId overwrites the earlier one", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "context_attribution", toolUseIds: ["t1"], tokens: 100, estimated: true }));
    act(() => result.current.handleEvent({ type: "context_attribution", toolUseIds: ["t1"], tokens: 250, estimated: false }));

    expect(result.current.attributionByToolUseId).toEqual({ t1: { tokens: 250, estimated: false } });
  });

  it("an AgentEvent variant the client doesn't recognize (protocol skew) is ignored, not a crash — the whole reason WS_PROTOCOL_VERSION exists is to keep this from happening for real, but the reducer stays safe on its own too", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.addUserMessage("before", undefined));
    // Simulates a relay newer than this client build — a variant that
    // doesn't exist in this build's AgentEvent union at all.
    act(() => result.current.handleEvent({ type: "some_future_variant" } as unknown as AgentEvent));

    expect(stripVolatile(result.current.entries)).toEqual([{ kind: "user", text: "before" }]);
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
      { kind: "turn-footer", text: "hello!" },
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

  it("keeps a subagent's work out of the log, tracking it as that subagent's own state", () => {
    const { result } = renderHook(() => useMessageLog());
    const events: AgentEvent[] = [
      { type: "tool_started", toolUseId: "agent", name: "Agent", kind: "task", input: { description: "audit", run_in_background: true } },
      { type: "subagent", toolUseId: "agent", status: "running", at: 1000, description: "audit", background: true },
      { type: "tool_ended", toolUseId: "agent", content: "Async agent launched successfully.", isError: false },
      { type: "text", text: "Launched it, carrying on.", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "tool_started", toolUseId: "r1", name: "Read", kind: "read", input: { file_path: "/w/a.txt" }, parentToolUseId: "agent" },
      { type: "tool_ended", toolUseId: "r1", content: "alpha", isError: false, parentToolUseId: "agent" },
      { type: "text", text: "Done: alpha.", parentToolUseId: "agent" },
      { type: "subagent", toolUseId: "agent", status: "running", at: 2000, activity: "Reading a.txt", toolUses: 1 },
    ];
    act(() => {
      for (const event of events) result.current.handleEvent(event);
    });

    expect(result.current.entries.map((entry) => entry.kind)).toEqual(["tool-call", "text"]);
    expect(result.current.subagents.agent).toMatchObject({
      status: "running",
      startedAt: 1000,
      background: true,
      description: "audit",
      activity: "Reading a.txt",
      toolUses: 1,
      toolCalls: [{ name: "Read", input: { file_path: "/w/a.txt" } }],
    });

    act(() => result.current.handleEvent({ type: "subagent", toolUseId: "agent", status: "completed", at: 3000, summary: "alpha" }));
    expect(result.current.subagents.agent).toMatchObject({ status: "completed", summary: "alpha", description: "audit" });
  });

  it("marks a subagent still running when the turn ends as stopped", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => {
      result.current.handleEvent({ type: "subagent", toolUseId: "agent", status: "running", at: 1000 });
      result.current.handleTurnComplete(true);
    });
    expect(result.current.subagents.agent.status).toBe("stopped");
  });

  it("ignores an end for something it never saw start (a subagent's own backgrounded shell)", () => {
    const { result } = renderHook(() => useMessageLog());
    act(() => result.current.handleEvent({ type: "subagent", toolUseId: "bash", status: "completed", at: 1000, summary: "sleep 8" }));
    expect(result.current.subagents).toEqual({});
  });
});
