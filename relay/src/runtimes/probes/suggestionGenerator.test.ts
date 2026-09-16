import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSuggestion, truncate } from "./suggestionGenerator.js";

test("truncate leaves short text alone", () => {
  assert.equal(truncate("short question"), "short question");
});

test("truncate cuts anything over 2000 chars, to avoid feeding a whole pasted snippet in just to infer a follow-up", () => {
  const long = "x".repeat(2500);
  const result = truncate(long);
  assert.equal(result.length, 2000);
  assert.equal(result, long.slice(0, 2000));
});

test("truncate: exactly 2000 chars is not truncated", () => {
  const exact = "x".repeat(2000);
  assert.equal(truncate(exact), exact);
});

test("normalizeSuggestion: a plain reply on a successful exit is returned as-is", () => {
  assert.equal(normalizeSuggestion("Can you also add tests?", 0), "Can you also add tests?");
});

test("normalizeSuggestion: strips a single layer of surrounding quotes the model sometimes adds anyway", () => {
  assert.equal(normalizeSuggestion('"Can you also add tests?"', 0), "Can you also add tests?");
  assert.equal(normalizeSuggestion("'Can you also add tests?'", 0), "Can you also add tests?");
});

test("normalizeSuggestion: trims surrounding whitespace", () => {
  assert.equal(normalizeSuggestion("  Can you also add tests?  \n", 0), "Can you also add tests?");
});

test("normalizeSuggestion: NONE (any case) means no suggestion", () => {
  assert.equal(normalizeSuggestion("NONE", 0), undefined);
  assert.equal(normalizeSuggestion("none", 0), undefined);
  assert.equal(normalizeSuggestion("  None  ", 0), undefined);
});

test("normalizeSuggestion: an empty reply means no suggestion", () => {
  assert.equal(normalizeSuggestion("", 0), undefined);
  assert.equal(normalizeSuggestion("   ", 0), undefined);
});

test("normalizeSuggestion: a non-zero exit means no suggestion, even with real-looking text on stdout", () => {
  assert.equal(normalizeSuggestion("Can you also add tests?", 1), undefined);
  assert.equal(normalizeSuggestion("Can you also add tests?", null), undefined);
});
