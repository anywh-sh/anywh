import { test } from "node:test";
import assert from "node:assert/strict";
import { BufferLineSplitter, StringLineSplitter } from "./lineSplitter.js";

test("StringLineSplitter: lines split across many chunks come out whole, in order", () => {
  const splitter = new StringLineSplitter();
  const big = "x".repeat(200_000);
  const input = `a\n${big}\nb\nc`;
  const lines: string[] = [];
  for (let i = 0; i < input.length; i += 1000) lines.push(...splitter.push(input.slice(i, i + 1000)));
  assert.deepEqual(lines, ["a", big, "b"]);
  assert.equal(splitter.pendingLength, 1);
  assert.deepEqual(splitter.push("\n"), ["c"]);
});

test("BufferLineSplitter: reports each line with its byte length and the position it ended at", () => {
  const splitter = new BufferLineSplitter(100);
  const input = Buffer.from("é1\nsecond line\n\nlast");
  const out: { line: string; start: number; end: number }[] = [];
  for (let i = 0; i < input.length; i += 3) out.push(...splitter.push(input.subarray(i, i + 3)));
  assert.deepEqual(out, [
    { line: "é1", start: 100, end: 104 },
    { line: "second line", start: 104, end: 116 },
    { line: "", start: 116, end: 117 },
  ]);
  assert.equal(splitter.position, 117);
});
