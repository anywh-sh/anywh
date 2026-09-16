import { test } from "node:test";
import assert from "node:assert/strict";
import { AVAILABLE_MODELS_RE, MODEL_NAME_RE, parseAvailableModels } from "./defaultModel.js";

// Real finding (documented in the file's own header comment): a CLI version
// started wrapping the `/model` probe's answer in markdown backticks, and
// MODEL_NAME_RE — anchored on a bare "Sonnet"/"Opus"/... right after "Current
// model:" — silently stopped matching. `detectDefaultModel` swallows a
// non-match as `undefined`, so this broke with no error anywhere, only a
// missing label in the UI. `fake-claude.mjs`'s default-model reply already
// carries the backticks (it was updated to match the real regression); this
// pins the regex against exactly that shape so it can't happen again unnoticed.
test("MODEL_NAME_RE matches the real regression: backtick-wrapped model names", () => {
  const match = MODEL_NAME_RE.exec("Current model: `Sonnet 5 (default)`");
  assert.ok(match);
  assert.equal(match[1], "Sonnet");
});

test("MODEL_NAME_RE also matches without backticks — the pre-regression shape", () => {
  const match = MODEL_NAME_RE.exec("Current model: Opus 5 (1M context) (default)");
  assert.ok(match);
  assert.equal(match[1], "Opus");
});

test("MODEL_NAME_RE matches all four known families, case-insensitively", () => {
  for (const [input, expected] of [
    ["Current model: `sonnet 5 (default)`", "sonnet"],
    ["Current model: `Opus 5 (default)`", "Opus"],
    ["Current model: `HAIKU 4.5 (default)`", "HAIKU"],
    ["Current model: `Fable 5.1 (default)`", "Fable"],
  ] as const) {
    const match = MODEL_NAME_RE.exec(input);
    assert.ok(match, input);
    assert.equal(match[1], expected);
  }
});

test("MODEL_NAME_RE doesn't match an unrelated or malformed line", () => {
  assert.equal(MODEL_NAME_RE.exec("Usage: /model <name>."), null);
  assert.equal(MODEL_NAME_RE.exec("Current model: Gemini 3 (default)"), null, "not one of the four known families");
  assert.equal(MODEL_NAME_RE.exec(""), null);
});

const REAL_USAGE_LINE =
  "Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.";

test("AVAILABLE_MODELS_RE captures the list up to the first period after 'Available:'", () => {
  const match = AVAILABLE_MODELS_RE.exec(REAL_USAGE_LINE);
  assert.ok(match);
  assert.equal(match[1], "sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID");
});

test("parseAvailableModels: splits the real usage line into aliases, dropping the 'or a full model ID' filler", () => {
  assert.deepEqual(parseAvailableModels(REAL_USAGE_LINE), [
    "sonnet",
    "opus",
    "haiku",
    "fable",
    "best",
    "sonnet[1m]",
    "opus[1m]",
    "fable[1m]",
    "opusplan",
    "default",
  ]);
});

test("parseAvailableModels: no 'Available:' segment at all returns an empty list", () => {
  assert.deepEqual(parseAvailableModels("Current model: `Sonnet 5 (default)`"), []);
});

test("parseAvailableModels: trims whitespace around each alias and drops empty tokens from a stray double comma", () => {
  assert.deepEqual(parseAvailableModels("Available: sonnet ,  opus ,, haiku."), ["sonnet", "opus", "haiku"]);
});
