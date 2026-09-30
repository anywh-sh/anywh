import { test } from "node:test";
import assert from "node:assert/strict";
import { mapCodexNotification } from "./codexAppServer.js";

// Payloads below follow the bindings `codex app-server generate-ts --experimental` emits.

const readAction = { type: "read", command: "sed -n 2,3p f.txt", name: "f.txt", path: "/w/f.txt" };

// ---- item/started -----------------------------------------------------------

test("item/started: a plain shell command becomes a shell call, unwrapped, timed by the daemon", () => {
  const params = {
    startedAtMs: 1_000,
    item: { type: "commandExecution", id: "item-1", command: "/usr/bin/bash -lc 'npm test | tail -5'", commandActions: [{ type: "unknown", command: "x" }, { type: "unknown", command: "y" }] },
  };
  assert.deepEqual(mapCodexNotification("item/started", params), [
    {
      type: "tool_started",
      toolUseId: "item-1",
      name: "commandExecution",
      kind: "shell",
      input: { command: "/usr/bin/bash -lc 'npm test | tail -5'" },
      subject: { kind: "shell", command: "npm test | tail -5" },
      startedAt: 1_000,
    },
  ]);
});

test("item/started: a command its own actions call a single read is shown as a read, with the range sed names", () => {
  const params = { item: { type: "commandExecution", id: "c", command: "/usr/bin/bash -lc 'sed -n 2,3p f.txt'", commandActions: [readAction] } };
  const [started] = mapCodexNotification("item/started", params);
  assert.equal(started?.type === "tool_started" && started.kind, "read");
  assert.deepEqual(started?.type === "tool_started" && started.subject, { kind: "read", path: "/w/f.txt", range: { start: 2, end: 3 } });
});

test("item/started: a single search or listing action becomes a search", () => {
  const search = { item: { type: "commandExecution", id: "s", command: "rg two f.txt", commandActions: [{ type: "search", command: "rg two f.txt", query: "two", path: "f.txt" }] } };
  const list = { item: { type: "commandExecution", id: "l", command: "ls src", commandActions: [{ type: "listFiles", command: "ls src", path: "src" }] } };
  const [a] = mapCodexNotification("item/started", search);
  const [b] = mapCodexNotification("item/started", list);
  assert.deepEqual(a?.type === "tool_started" && a.subject, { kind: "search", mode: "content", pattern: "two", path: "f.txt" });
  assert.deepEqual(b?.type === "tool_started" && b.subject, { kind: "search", mode: "files", pattern: "*", path: "src" });
});

test("item/started: a patch touching several files becomes one call per file", () => {
  const params = {
    startedAtMs: 5,
    item: {
      type: "fileChange",
      id: "p",
      changes: [
        { path: "/w/a.ts", kind: { type: "update", move_path: null }, diff: "" },
        { path: "/w/b.ts", kind: { type: "add" }, diff: "" },
      ],
    },
  };
  const events = mapCodexNotification("item/started", params);
  assert.deepEqual(
    events.map((e) => e.type === "tool_started" && [e.toolUseId, e.kind, e.subject]),
    [
      ["p#0", "edit", { kind: "edit", path: "/w/a.ts" }],
      ["p#1", "write", { kind: "write", path: "/w/b.ts" }],
    ],
  );
});

test("item/started: mcpToolCall carries the server and tool in its subject", () => {
  const params = { item: { type: "mcpToolCall", id: "item-3", server: "anywh-choice", tool: "present_choice", arguments: { question: "?" } } };
  assert.deepEqual(mapCodexNotification("item/started", params), [
    {
      type: "tool_started",
      toolUseId: "item-3",
      name: "anywh-choice:present_choice",
      kind: "mcp",
      input: { question: "?" },
      subject: { kind: "mcp", server: "anywh-choice", tool: "present_choice" },
    },
  ]);
});

test("item/started: webSearch becomes a web call, an opened page a fetch", () => {
  const search = { item: { type: "webSearch", id: "w", query: "codex", action: { type: "search", query: "codex", queries: null } } };
  const open = { item: { type: "webSearch", id: "o", query: "", action: { type: "openPage", url: "https://x.dev" } } };
  const [a] = mapCodexNotification("item/started", search);
  const [b] = mapCodexNotification("item/started", open);
  assert.deepEqual(a?.type === "tool_started" && [a.kind, a.subject], ["web", { kind: "web", mode: "search", query: "codex" }]);
  assert.deepEqual(b?.type === "tool_started" && b.subject, { kind: "web", mode: "fetch", url: "https://x.dev" });
});

test("item/started: reasoning announces itself, agentMessage and plan stay silent", () => {
  assert.deepEqual(mapCodexNotification("item/started", { startedAtMs: 7, item: { type: "reasoning", id: "r", summary: [], content: [] } }), [{ type: "thinking_started", startedAt: 7 }]);
  for (const type of ["agentMessage", "plan"]) {
    assert.deepEqual(mapCodexNotification("item/started", { item: { type, id: "x" } }), []);
  }
});

test("item/started: an unrecognized item type is dropped, not thrown", () => {
  assert.deepEqual(mapCodexNotification("item/started", { item: { type: "someFutureItemType", id: "x" } }), []);
});

test("item/started: a missing item doesn't throw", () => {
  assert.deepEqual(mapCodexNotification("item/started", {}), []);
});

// ---- item/completed ----------------------------------------------------------

test("item/completed: agentMessage becomes the committed text", () => {
  const params = { item: { type: "agentMessage", id: "item-1", text: "hello" } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [{ type: "text", text: "hello" }]);
});

test("item/completed: reasoning becomes thinking, joining multiple content parts", () => {
  const params = { completedAtMs: 9, item: { type: "reasoning", id: "item-1", summary: [], content: ["step one", "step two"] } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [{ type: "thinking", thinking: "step one\nstep two", endedAt: 9 }]);
});

test("item/completed: reasoning with no content falls back to its summary", () => {
  const params = { item: { type: "reasoning", id: "item-1", summary: ["Checking the tests"], content: [] } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [{ type: "thinking", thinking: "Checking the tests" }]);
});

test("item/completed: reasoning with neither is still reported, for its timing", () => {
  const params = { item: { type: "reasoning", id: "item-1", summary: [], content: [] } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [{ type: "thinking", thinking: "" }]);
});

test("item/completed: plan is plain text, not a structured todo list — Codex's plan item is free-text prose, unlike Claude's TodoWrite", () => {
  const params = { item: { type: "plan", id: "item-1", text: "1. Do the thing\n2. Then the other thing" } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [{ type: "text", text: "1. Do the thing\n2. Then the other thing" }]);
});

test("item/completed: a shell command reports terminal output with its exit code", () => {
  const params = {
    completedAtMs: 20,
    item: { type: "commandExecution", id: "item-1", command: "ls", commandActions: [], status: "completed", aggregatedOutput: "ok\n", exitCode: 0 },
  };
  assert.deepEqual(mapCodexNotification("item/completed", params), [
    { type: "tool_ended", toolUseId: "item-1", content: "ok\n", isError: false, outcome: { kind: "terminal", output: "ok\n", exitCode: 0 }, endedAt: 20 },
  ]);
});

test("item/completed: a failed command is an error, and a null output falls back to an empty string", () => {
  const params = { item: { type: "commandExecution", id: "item-1", command: "false", commandActions: [], status: "failed", aggregatedOutput: null, exitCode: 1 } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [
    { type: "tool_ended", toolUseId: "item-1", content: "", isError: true, outcome: { kind: "terminal", output: "", exitCode: 1 } },
  ]);
});

test("item/completed: a command declined by the user also counts as isError (it's not 'completed')", () => {
  const params = { item: { type: "commandExecution", id: "item-1", command: "rm x", commandActions: [], status: "declined", aggregatedOutput: null, exitCode: null } };
  assert.equal((mapCodexNotification("item/completed", params)[0] as { isError: boolean }).isError, true);
});

test("item/completed: a read command's output becomes numbered code when the range is known, unnumbered when not", () => {
  const ranged = { item: { type: "commandExecution", id: "r", command: "sed -n 2,3p f.txt", commandActions: [readAction], status: "completed", aggregatedOutput: "two\nthree\n", exitCode: 0 } };
  const whole = { item: { type: "commandExecution", id: "r", command: "cat f.txt", commandActions: [{ ...readAction, command: "cat f.txt" }], status: "completed", aggregatedOutput: "one\ntwo\n", exitCode: 0 } };
  const [a] = mapCodexNotification("item/completed", ranged);
  const [b] = mapCodexNotification("item/completed", whole);
  assert.deepEqual(a?.type === "tool_ended" && a.outcome, { kind: "code", path: "/w/f.txt", lines: ["two", "three"], startLine: 2 });
  assert.deepEqual(b?.type === "tool_ended" && b.outcome, { kind: "code", path: "/w/f.txt", lines: ["one", "two"] });
});

test("item/completed: a search command's output becomes matches, a listing becomes files", () => {
  const search = { item: { type: "commandExecution", id: "s", command: "rg -n two", commandActions: [{ type: "search", command: "rg -n two", query: "two", path: null }], status: "completed", aggregatedOutput: "f.txt:2:two\nnote", exitCode: 0 } };
  const list = { item: { type: "commandExecution", id: "l", command: "ls", commandActions: [{ type: "listFiles", command: "ls", path: null }], status: "completed", aggregatedOutput: "a.ts\nb.ts\n", exitCode: 0 } };
  const [a] = mapCodexNotification("item/completed", search);
  const [b] = mapCodexNotification("item/completed", list);
  assert.deepEqual(a?.type === "tool_ended" && a.outcome, {
    kind: "matches",
    matches: [
      { path: "f.txt", line: 2, text: "two" },
      { path: "", text: "note" },
    ],
  });
  assert.deepEqual(b?.type === "tool_ended" && b.outcome, { kind: "files", paths: ["a.ts", "b.ts"] });
});

test("item/completed: a failed read stays terminal output instead of pretending to be code", () => {
  const params = { item: { type: "commandExecution", id: "r", command: "cat nope", commandActions: [readAction], status: "failed", aggregatedOutput: "cat: nope: No such file", exitCode: 1 } };
  const [ended] = mapCodexNotification("item/completed", params);
  assert.deepEqual(ended?.type === "tool_ended" && ended.outcome, { kind: "terminal", output: "cat: nope: No such file", exitCode: 1 });
});

test("item/completed: fileChange ends one call per file, each with its own diff", () => {
  const params = {
    completedAtMs: 30,
    item: {
      type: "fileChange",
      id: "p",
      status: "completed",
      changes: [
        { path: "/w/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n" },
        { path: "/w/b.ts", kind: { type: "add" }, diff: "hello\nworld\n" },
      ],
    },
  };
  const events = mapCodexNotification("item/completed", params);
  assert.deepEqual(events[0], {
    type: "tool_ended",
    toolUseId: "p#0",
    content: "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n",
    isError: false,
    outcome: { kind: "diff", path: "/w/a.ts", hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" one", "-two", "+TWO"] }], added: 1, removed: 1 },
    endedAt: 30,
  });
  assert.deepEqual(events[1]?.type === "tool_ended" && events[1].outcome, {
    kind: "diff",
    path: "/w/b.ts",
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+hello", "+world"] }],
    added: 2,
    removed: 0,
    created: true,
  });
});

test("item/completed: a deleted file is an all-removed hunk", () => {
  const params = { item: { type: "fileChange", id: "p", status: "completed", changes: [{ path: "/w/x.ts", kind: { type: "delete" }, diff: "bye\n" }] } };
  const [ended] = mapCodexNotification("item/completed", params);
  assert.deepEqual(ended?.type === "tool_ended" && ended.outcome, {
    kind: "diff",
    path: "/w/x.ts",
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-bye"] }],
    added: 0,
    removed: 1,
  });
});

test("item/completed: a fileChange with no changes maps to nothing rather than throwing", () => {
  assert.deepEqual(mapCodexNotification("item/completed", { item: { type: "fileChange", id: "p", status: "completed", changes: [] } }), []);
  assert.deepEqual(mapCodexNotification("item/completed", { item: { type: "fileChange", id: "p", status: "completed" } }), []);
});

test("item/completed: mcpToolCall reports its result as a payload, isError false when completed", () => {
  const params = { item: { type: "mcpToolCall", id: "item-1", status: "completed", arguments: { id: 1 }, result: { ok: true }, error: null } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [
    {
      type: "tool_ended",
      toolUseId: "item-1",
      content: JSON.stringify({ ok: true }),
      isError: false,
      outcome: { kind: "payload", request: JSON.stringify({ id: 1 }, null, 2), response: JSON.stringify({ ok: true }) },
    },
  ]);
});

test("item/completed: mcpToolCall reports its error over its result, isError true when failed", () => {
  const params = { item: { type: "mcpToolCall", id: "item-1", status: "failed", arguments: {}, result: null, error: { message: "boom" } } };
  const [ended] = mapCodexNotification("item/completed", params);
  assert.equal(ended?.type === "tool_ended" && ended.content, JSON.stringify({ message: "boom" }));
  assert.equal(ended?.type === "tool_ended" && ended.isError, true);
});

test("item/completed: webSearch links come from whatever url-carrying objects its opaque results hold, text when none", () => {
  const withLinks = { item: { type: "webSearch", id: "w", query: "q", action: null, results: [{ title: "One", url: "https://one.dev" }, { nested: [{ url: "https://two.dev" }] }] } };
  const without = { item: { type: "webSearch", id: "w", query: "q", action: null, results: null } };
  const [a] = mapCodexNotification("item/completed", withLinks);
  const [b] = mapCodexNotification("item/completed", without);
  assert.deepEqual(a?.type === "tool_ended" && a.outcome, {
    kind: "links",
    results: [
      { title: "One", url: "https://one.dev" },
      { title: "https://two.dev", url: "https://two.dev" },
    ],
  });
  assert.deepEqual(b?.type === "tool_ended" && b.outcome, { kind: "text" });
});

test("item/completed: an unrecognized item type is dropped, not thrown", () => {
  assert.deepEqual(mapCodexNotification("item/completed", { item: { type: "sleep", id: "x" } }), []);
});

// ---- deltas and usage ---------------------------------------------------------

test("item/agentMessage/delta streams text, correlated by the item id", () => {
  assert.deepEqual(mapCodexNotification("item/agentMessage/delta", { threadId: "t", turnId: "u", itemId: "i", delta: "hel" }), [
    { type: "text_delta", index: "i", text: "hel" },
  ]);
});

test("reasoning deltas, summary or raw, stream as thinking", () => {
  assert.deepEqual(mapCodexNotification("item/reasoning/summaryTextDelta", { itemId: "r", delta: "Look", summaryIndex: 0 }), [{ type: "thinking_delta", index: "r", thinking: "Look" }]);
  assert.deepEqual(mapCodexNotification("item/reasoning/textDelta", { itemId: "r", delta: "hm", contentIndex: 0 }), [{ type: "thinking_delta", index: "r", thinking: "hm" }]);
});

test("a delta without an item id is dropped", () => {
  assert.deepEqual(mapCodexNotification("item/agentMessage/delta", { delta: "x" }), []);
});

test("thread/tokenUsage/updated maps the LAST response's breakdown, renaming Codex's field names to AgentEvent's", () => {
  const params = {
    tokenUsage: {
      total: { totalTokens: 999, inputTokens: 999, cachedInputTokens: 999, cacheWriteInputTokens: 999, outputTokens: 999, reasoningOutputTokens: 999 },
      last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 15, reasoningOutputTokens: 0 },
      modelContextWindow: 200000,
    },
  };
  const [usage] = mapCodexNotification("thread/tokenUsage/updated", params);
  assert.deepEqual(usage, {
    type: "usage",
    inputTokens: 100,
    cacheCreationInputTokens: 5,
    cacheReadInputTokens: 20,
    prefixTokens: 100,
    outputTokens: 15,
    contextWindowSize: 200000,
  });
});

test("thread/tokenUsage/updated computes prefixTokens from inputTokens alone, never summed with cachedInputTokens — Codex's cache slice is a subset of input, not additive like Claude's", () => {
  const params = {
    tokenUsage: {
      last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 15, reasoningOutputTokens: 0 },
      modelContextWindow: 200000,
    },
  };
  const [usage] = mapCodexNotification("thread/tokenUsage/updated", params);
  assert.equal(usage?.type, "usage");
  // A naive sum (input + cacheWrite + cachedInput) would report 125 — the
  // double-count bug this mapper exists to avoid.
  assert.strictEqual(usage?.type === "usage" ? usage.prefixTokens : undefined, 100);
});

test("thread/tokenUsage/updated with no 'last' breakdown produces nothing", () => {
  assert.deepEqual(mapCodexNotification("thread/tokenUsage/updated", { tokenUsage: {} }), []);
});

// ---- unrecognized notifications -------------------------------------------

test("an unrecognized top-level method is dropped, not thrown", () => {
  assert.deepEqual(mapCodexNotification("marketplace/add/completed", { anything: true }), []);
});
