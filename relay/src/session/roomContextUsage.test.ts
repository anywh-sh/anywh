import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../protocol/agent-event.js";
import { ContextTally } from "./roomContextUsage.js";

const usage = (prefix: number, contextWindowSize?: number): AgentEvent => ({
  type: "usage",
  inputTokens: 1,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: prefix - 1,
  prefixTokens: prefix,
  outputTokens: 3,
  ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
});

test("a response replaces the previous one instead of adding to it", () => {
  const tally = new ContextTally();
  tally.observe("a", usage(1000));
  tally.observe("a", usage(1200));
  assert.deepEqual(tally.get("a"), { usedTokens: 1200 });
});

test("the window, once reported, survives responses that do not repeat it", () => {
  const tally = new ContextTally();
  tally.observe("a", usage(1000, 200_000));
  tally.observe("a", usage(1200));
  assert.deepEqual(tally.get("a"), { usedTokens: 1200, contextWindowSize: 200_000 });
});

test("other events and unknown agents count for nothing, and forgetting resets", () => {
  const tally = new ContextTally();
  tally.observe("a", usage(5));
  tally.observe("a", { type: "turn_started" });
  assert.equal(tally.get("nobody"), undefined);
  assert.deepEqual(tally.get("a"), { usedTokens: 5 });
  tally.forget("a");
  assert.equal(tally.get("a"), undefined);
});
