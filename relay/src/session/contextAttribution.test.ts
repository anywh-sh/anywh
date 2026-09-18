import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextAttributor } from "./contextAttribution.js";
import type { AgentEvent } from "../protocol/agent-event.js";

function usage(prefixTokens: number, outputTokens: number, extra: Partial<Extract<AgentEvent, { type: "usage" }>> = {}): AgentEvent {
  return { type: "usage", inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, prefixTokens, outputTokens, ...extra };
}

function toolEnded(toolUseId?: string, content = ""): AgentEvent {
  return { type: "tool_ended", toolUseId, content, isError: false };
}

test("first usage of a brand-new conversation sets baseline, no attribution (nothing came before it)", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: false });
  const step = attributor.observe(usage(45448, 7023));
  assert.deepEqual(step, { baseline: 45448, used: 45448 });
});

test("baseline never fires twice, even across many subsequent steps", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: false });
  attributor.observe(usage(45448, 7023));
  const step2 = attributor.observe(usage(53704, 100));
  assert.equal("baseline" in step2!, false);
});

test("a resumed session's first usage has no predecessor: used is reported, but neither baseline nor attribution", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: true });
  const step = attributor.observe(usage(120000, 50));
  assert.deepEqual(step, { used: 120000 });
});

// ---- the delta-of-prefix table, real numbers from a real session -----------
// (~/.claude/projects/-home-wil-personal-ultron/b2c9ad93….jsonl, journal §3):
//    #    prefixo    delta cache_cr prevOut  atribuído  fonte
//    0     45448    45448    17344       0      45448  (baseline)
//    4     56657     8256     8256    7023       1233  Agent ×3
//    9     78089     6221     6221     951       5270  Read, Bash
//   14     99963    13752    13752     280      13472  Read      <-- one Read, 13k
//   18    110856     7150    82752     396       6754  (cache refresh)
//   33    138721     6408     6408     137       6271  Bash
//
// Each row is replayed as its own two-step mini-sequence (base value is
// arbitrary; only the delta and prevOut, both real, matter) — proves the
// formula against real measured numbers, not a synthetic table.
for (const row of [
  { delta: 8256, prevOut: 7023, attributed: 1233, label: "row 4 (Agent x3)" },
  { delta: 6221, prevOut: 951, attributed: 5270, label: "row 9 (Read, Bash)" },
  { delta: 13752, prevOut: 280, attributed: 13472, label: "row 14 — the headline case: one Read, 13.4k tokens" },
  { delta: 6408, prevOut: 137, attributed: 6271, label: "row 33 (Bash)" },
]) {
  test(`delta-of-prefix formula matches the real session's own attributed total — ${row.label}`, () => {
    const attributor = new ContextAttributor({ hasPriorConversation: true });
    attributor.observe(usage(1_000_000, row.prevOut));
    const step = attributor.observe(usage(1_000_000 + row.delta, 999));
    assert.equal(step?.attribution?.tokens, row.attributed);
  });
}

test("cache_creation_input_tokens is never read for the delta, even when it wildly disagrees with the real prefix growth (measured: 82,752 vs a real delta of 7,150)", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: true });
  attributor.observe(usage(103_706, 396, { cacheCreationInputTokens: 999_999 }));
  // Real row 18: delta 7150, prevOut 396, attributed 6754 — a naive
  // cache_creation-based implementation would report 82,356 (82752 - 396)
  // for this same pair; the field isn't even read by `observe`, so there's
  // no way for a caller to accidentally trigger that bug.
  const step = attributor.observe(usage(103_706 + 7150, 999, { cacheCreationInputTokens: 82_752 }));
  assert.equal(step?.attribution?.tokens, 6754);
});

test("compact_boundary resets the predecessor: the series never diffs across a compaction (measured real delta: -589,482)", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: true });
  attributor.observe(usage(589_482, 500));
  attributor.observe({ type: "compact_boundary", trigger: "auto", preTokens: 589_482 });
  const step = attributor.observe(usage(21_197, 50));
  assert.deepEqual(step, { used: 21_197 });
});

test("compact_boundary never re-arms baseline — a post-compaction step stays attribution-less, not baseline", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: false });
  attributor.observe(usage(45_448, 500)); // real baseline, conversation start
  attributor.observe({ type: "compact_boundary", trigger: "manual", preTokens: 800_000 });
  const step = attributor.observe(usage(30_000, 50));
  assert.deepEqual(step, { used: 30_000 });
});

test("a single tool_ended's whole delta is attributed to it, exact (estimated: false) — no division needed for one source", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: true });
  attributor.observe(usage(1000, 10));
  attributor.observe(toolEnded("tool-a", "x".repeat(50)));
  const step = attributor.observe(usage(1200, 10));
  assert.deepEqual(step?.attribution, {
    tokens: 190,
    toolUseIds: ["tool-a"],
    estimated: false,
    bySource: [{ toolUseId: "tool-a", tokens: 190 }],
  });
});

test("a parallel batch's delta is divided proportionally by each tool_ended's own content.length, marked estimated, but the sum stays exact", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: true });
  attributor.observe(usage(1000, 10));
  attributor.observe(toolEnded("tool-a", "x".repeat(10)));
  attributor.observe(toolEnded("tool-b", "y".repeat(30)));
  const step = attributor.observe(usage(1200, 10));
  // delta 200 - prevOut 10 = 190, weights 10:30 -> round(190*10/40)=48,
  // last absorbs the remainder: 190-48=142. 48+142=190, exact.
  assert.deepEqual(step?.attribution, {
    tokens: 190,
    toolUseIds: ["tool-a", "tool-b"],
    estimated: true,
    bySource: [
      { toolUseId: "tool-a", tokens: 48 },
      { toolUseId: "tool-b", tokens: 142 },
    ],
  });

  // Collected ids don't leak into the following step once consumed.
  const nextStep = attributor.observe(usage(1300, 10));
  assert.deepEqual(nextStep?.attribution?.toolUseIds, []);
});

test("a parallel batch where every tool_ended reported empty content divides equally, not by zero", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: true });
  attributor.observe(usage(1000, 10));
  attributor.observe(toolEnded("tool-a", ""));
  attributor.observe(toolEnded("tool-b", ""));
  attributor.observe(toolEnded("tool-c", ""));
  const step = attributor.observe(usage(1301, 10));
  // delta 301 - prevOut 10 = 291, split 3 ways: round(291/3)=97 twice, last
  // absorbs the remainder (291 - 97 - 97 = 97 too, here exactly divisible).
  assert.deepEqual(
    step?.attribution?.bySource.map((s) => s.tokens),
    [97, 97, 97],
  );
});

test("tool_ended with no toolUseId is not attributed to a specific tool call, but doesn't throw", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: true });
  attributor.observe(usage(1000, 10));
  attributor.observe(toolEnded(undefined));
  const step = attributor.observe(usage(1100, 10));
  assert.deepEqual(step?.attribution?.toolUseIds, []);
});

test("a delta with no tool_ended in between (toolUseIds empty) still reports its token total — a plain user message is a valid, sourceless attribution", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: true });
  attributor.observe(usage(1000, 10));
  const step = attributor.observe(usage(17_389, 10));
  assert.deepEqual(step?.attribution, { tokens: 16_379, toolUseIds: [], estimated: false, bySource: [] });
});

test("contextWindowSize passes through only when the event carries it (Codex), absent otherwise (Claude)", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: true });
  const withWindow = attributor.observe(usage(1000, 10, { contextWindowSize: 200_000 }));
  assert.equal(withWindow?.contextWindowSize, 200_000);
  const withoutWindow = attributor.observe(usage(1200, 10));
  assert.equal("contextWindowSize" in withoutWindow!, false);
});

test("non-usage, non-tool_ended, non-compact_boundary events are observed as a no-op", () => {
  const attributor = new ContextAttributor({ hasPriorConversation: true });
  assert.equal(attributor.observe({ type: "text", text: "hi" }), undefined);
  assert.equal(attributor.observe({ type: "session_id", sessionId: "s1" }), undefined);
});
