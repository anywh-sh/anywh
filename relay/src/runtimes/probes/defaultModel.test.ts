import { test } from "node:test";
import assert from "node:assert/strict";
import { AVAILABLE_MODELS_RE, parseAvailableModels, parseCurrentModel } from "./defaultModel.js";

// Real finding (documented in the file's own header comment): a CLI version
// started wrapping the `/model` probe's answer in markdown backticks, and the
// regex then in use silently stopped matching. `detectDefaultModel` swallows a
// non-match as `undefined`, so this broke with no error anywhere, only a
// missing label in the UI. `fake-claude.mjs`'s default-model reply already
// carries the backticks (it was updated to match the real regression); this
// pins the parser against exactly that shape so it can't happen again unnoticed.
test("parseCurrentModel matches the real regression: backtick-wrapped model names", () => {
  assert.equal(parseCurrentModel("Current model: `Sonnet 5 (default)`"), "Sonnet 5");
});

test("parseCurrentModel also matches without backticks — the pre-regression shape", () => {
  assert.equal(parseCurrentModel("Current model: Opus 5 (1M context) (default)"), "Opus 5 (1M context)");
});

// The point of keeping the version at all: the picker used to show only the
// family ("Opus"), with no way to tell which release an alias pointed at.
// Shapes below are verbatim from the real CLI under `--model <alias>`.
test("parseCurrentModel keeps the version and any qualifier, dropping only the '(default)' marker", () => {
  for (const [input, expected] of [
    ["Current model: `Opus 5.5 (default)`", "Opus 5.5"],
    ["Current model: `Opus 5.5`", "Opus 5.5"],
    ["Current model: `Haiku 4.5`", "Haiku 4.5"],
    ["Current model: `Opus 5.5 (1M context)`", "Opus 5.5 (1M context)"],
    ["Current model: `Opus in plan mode, else Sonnet`", "Opus in plan mode, else Sonnet"],
  ] as const) {
    assert.equal(parseCurrentModel(input), expected, input);
  }
});

test("parseCurrentModel finds the 'Current model:' line inside the full multi-line result", () => {
  assert.equal(
    parseCurrentModel("Current model: `Fable 5.1`\nUsage: /model <name>. Available: sonnet, opus, or a full model ID."),
    "Fable 5.1",
  );
});

test("parseCurrentModel returns undefined for an unrelated or empty line", () => {
  assert.equal(parseCurrentModel("Usage: /model <name>."), undefined);
  assert.equal(parseCurrentModel("Current model: `(default)`"), undefined);
  assert.equal(parseCurrentModel(""), undefined);
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
