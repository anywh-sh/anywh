import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "./unifiedDiff.js";

test("a single hunk keeps its header numbers and its lines, minus the file headers", () => {
  const diff = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three", ""].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff), [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" one", "-two", "+TWO", " three"] }]);
});

test("several hunks stay separate", () => {
  const diff = ["@@ -1,2 +1,2 @@", "-a", "+b", " c", "@@ -10,2 +10,3 @@", " x", "+y", " z"].join("\n");
  const hunks = parseUnifiedDiff(diff);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[1]?.oldStart, 10);
  assert.deepEqual(hunks[1]?.lines, [" x", "+y", " z"]);
});

test("omitted counts default to one line, and the no-newline marker is dropped", () => {
  const diff = ["@@ -3 +3 @@", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file"].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff), [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-old", "+new"] }]);
});

test("a blank context line whose space was stripped is still counted", () => {
  const diff = ["@@ -1,3 +1,3 @@", " a", "", "-b", "+c", ""].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff)[0]?.lines, [" a", " ", "-b", "+c"]);
});

test("text that is not a diff has no hunks", () => {
  assert.deepEqual(parseUnifiedDiff("hello\nworld"), []);
  assert.deepEqual(parseUnifiedDiff(""), []);
});
