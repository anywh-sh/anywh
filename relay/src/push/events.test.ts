import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanBody, promptDraft, turnEndedDraft, turnFailedDraft } from "./events.js";

// Vectors recorded by running the desktop client's own cleanBody
// (client/src/lib/platform/notifications.ts) on each input, so the two stay
// the same function.
test("cleanBody drops markdown markers and collapses whitespace", () => {
  assert.equal(cleanBody("Done. **All** tests `pass`."), "Done. All tests pass.");
  assert.equal(cleanBody("   spaced\n\n out\t text  "), "spaced out text");
  assert.equal(cleanBody("snake_case_name stays? no: _underscores_ go"), "snakecasename stays? no: underscores go");
});

test("cleanBody removes fenced code blocks entirely", () => {
  assert.equal(cleanBody("Before\n```ts\nconst x = 1;\n```\nAfter"), "Before After");
  assert.equal(cleanBody("```js\nonly code\n```"), "");
});

test("cleanBody truncates at a word boundary past 160 characters, and not at all at 160", () => {
  const words = cleanBody("word ".repeat(60));
  assert.ok(words.endsWith("word…"));
  assert.ok(words.length <= 161);
  assert.equal(cleanBody("a".repeat(160)), "a".repeat(160));
  assert.equal(cleanBody("a".repeat(161)), `${"a".repeat(160)}…`, "no space to cut at: cuts mid-word, like the client");
  assert.equal(cleanBody("é".repeat(170)), `${"é".repeat(160)}…`);
});

test("a finished turn previews the reply, then the user's message, then nothing", () => {
  const base = { title: "Fix build", stopped: false };
  assert.deepEqual(turnEndedDraft({ ...base, lastAssistantText: "All **green**.", userText: "run tests" }), {
    kind: "turn_completed",
    title: "Fix build",
    preview: "All green.",
  });
  assert.equal(turnEndedDraft({ ...base, userText: "run tests" }).preview, "run tests", "tool-only reply falls back to the user's text");
  assert.equal(turnEndedDraft({ ...base, lastAssistantText: "```x```", userText: "run tests" }).preview, "run tests", "a reply that cleans to nothing is no reply");
  assert.equal(turnEndedDraft({ ...base }).preview, null, "a relay-started turn with no reply has nothing to show");
});

test("a stopped turn carries no preview", () => {
  assert.deepEqual(turnEndedDraft({ title: null, stopped: true, lastAssistantText: "partial", userText: "x" }), {
    kind: "turn_stopped",
    title: null,
    preview: null,
  });
});

test("a failed turn never carries the error text", () => {
  assert.deepEqual(turnFailedDraft("t"), { kind: "turn_failed", title: "t", preview: null });
});

test("an approval prompt reveals nothing about the action; a choice previews its question", () => {
  assert.deepEqual(promptDraft({ title: "t", kind: "approval", firstQuestion: "Run rm -rf /secret?" }), {
    kind: "approval_required",
    title: "t",
    preview: null,
  });
  assert.deepEqual(promptDraft({ title: "t", kind: "choice", firstQuestion: "Which **database**?" }), {
    kind: "choice_required",
    title: "t",
    preview: "Which database?",
  });
  assert.equal(promptDraft({ title: "t", kind: "choice" }).preview, null);
});
