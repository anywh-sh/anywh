import { test } from "node:test";
import assert from "node:assert/strict";
import { countTokens } from "./tokenizer.js";

test("countTokens returns a plausible, nonzero count for a short real string, per encoding", async () => {
  const text = "hello world, this is a calibration probe";
  const cl100k = await countTokens(text, "cl100k_base");
  const o200k = await countTokens(text, "o200k_base");
  assert.ok(cl100k > 0 && cl100k < 20, `expected a small nonzero count, got ${cl100k}`);
  assert.ok(o200k > 0 && o200k < 20, `expected a small nonzero count, got ${o200k}`);
});

test("countTokens is deterministic across repeated calls (the lazy encoder loader memoizes correctly)", async () => {
  const text = "the quick brown fox jumps over the lazy dog";
  const first = await countTokens(text, "cl100k_base");
  const second = await countTokens(text, "cl100k_base");
  assert.equal(first, second);
});

test("countTokens scales with input size, not a constant", async () => {
  const short = await countTokens("hi", "cl100k_base");
  const long = await countTokens("hi ".repeat(500), "cl100k_base");
  assert.ok(long > short * 100, `expected a long repeated string to tokenize far larger than "hi", got short=${short} long=${long}`);
});
