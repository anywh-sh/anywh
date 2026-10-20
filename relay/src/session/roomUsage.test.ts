import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../protocol/agent-event.js";
import { mapClaudeEvent } from "../runtimes/streams/claudeStreamJson.js";
import { UsageTally } from "./roomUsage.js";

const usage = (input: number, creation: number, read: number): AgentEvent => ({ type: "usage", inputTokens: input, cacheCreationInputTokens: creation, cacheReadInputTokens: read, prefixTokens: input + creation + read, outputTokens: 3 });

test("an agent that wrote the cache has a low rate, a sibling that read it a high one", () => {
  const tally = new UsageTally();
  tally.observe("first", usage(10, 15_000, 0));
  tally.observe("sibling", usage(10, 200, 14_800));
  assert.equal(tally.get("first").cacheHitRate, 0);
  assert.ok((tally.get("sibling").cacheHitRate ?? 0) > 0.95);
  assert.equal(tally.get("sibling").responses, 1);
});

test("responses add up, other events and unknown agents count for nothing", () => {
  const tally = new UsageTally();
  tally.observe("a", usage(1, 0, 3));
  tally.observe("a", usage(1, 0, 3));
  tally.observe("a", { type: "turn_started" });
  assert.deepEqual(tally.get("a"), { responses: 2, inputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 6, cacheHitRate: 0.75 });
  assert.deepEqual(tally.get("nobody"), { responses: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cacheHitRate: null });
  tally.forget("a");
  assert.equal(tally.get("a").responses, 0);
});

// A real response split by the stream into one event per content block
// (thinking, text, tool_use): same message id and usage on every one.
const responseSplitInBlocks = (id: string, cacheRead: number): AgentEvent[] =>
  ["thinking", "text", "tool_use"].flatMap((block) =>
    mapClaudeEvent({
      type: "assistant",
      message: { id, content: [{ type: block === "text" ? "text" : block, text: "x", thinking: "x", id: `tu-${id}`, name: "Read", input: {} }], usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: cacheRead, output_tokens: 2 } },
    }).filter((e) => e.type === "usage"),
  );

test("a response split into several content-block events is counted once", () => {
  const tally = new UsageTally();
  for (const event of [...responseSplitInBlocks("msg_1", 1000), ...responseSplitInBlocks("msg_2", 1200)]) tally.observe("a", event);
  assert.deepEqual(tally.get("a"), { responses: 2, inputTokens: 10, cacheCreationInputTokens: 200, cacheReadInputTokens: 2200, cacheHitRate: 2200 / 2410 });
});

test("a replayed response is not counted again, and forgetting an agent resets that", () => {
  const tally = new UsageTally();
  for (const event of responseSplitInBlocks("msg_1", 1000)) tally.observe("a", event);
  for (const event of responseSplitInBlocks("msg_1", 1000)) tally.observe("a", event);
  assert.equal(tally.get("a").responses, 1);
  tally.forget("a");
  for (const event of responseSplitInBlocks("msg_1", 1000)) tally.observe("a", event);
  assert.equal(tally.get("a").responses, 1);
});
