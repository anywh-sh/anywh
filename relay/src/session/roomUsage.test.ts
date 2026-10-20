import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../protocol/agent-event.js";
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
