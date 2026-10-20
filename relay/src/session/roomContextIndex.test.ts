import assert from "node:assert/strict";
import { test } from "node:test";
import { encode } from "gpt-tokenizer";
import { INDEX_MAX_CHARS, buildIndex, buildNotice, estimateTokens, summarize, type ContextItem } from "./roomContextIndex.js";

const item = (name: string, at: number, extra: Partial<ContextItem> = {}): ContextItem => ({
  name,
  kind: "text",
  bytes: 900,
  lines: 40,
  author: "user",
  summary: "Brief for the checkout redesign",
  at,
  ...extra,
});

test("an empty room still gets a short, honest index", () => {
  const index = buildIndex("/r/room-1", []);
  assert.match(index, /\/r\/room-1/);
  assert.match(index, /no items yet/);
});

test("one line per item: name, kind, size, author, summary", () => {
  const index = buildIndex("/r", [item("brief.md", 1), item("spec.pdf", 2, { kind: "pdf", pages: 12, lines: undefined, extraction: "spec.pdf.txt", summary: "API spec" })]);
  assert.match(index, /- `brief\.md` · text · 40 lines · user · Brief for the checkout redesign/);
  assert.match(index, /- `spec\.pdf` · text in `spec\.pdf\.txt` · pdf · 12 pages · user · API spec/);
});

test("a large item says to read it in parts", () => {
  const index = buildIndex("/r", [item("dump.txt", 1, { lines: 90_000, largeTokens: 120_000 })]);
  assert.match(index, /LARGE \(~120k tokens\): read in parts/);
});

test("the index stays inside the budget however many items there are, newest kept", () => {
  const items = Array.from({ length: 400 }, (_, i) => item(`file-${String(i).padStart(3, "0")}-${"x".repeat(60)}.md`, i, { summary: "s".repeat(300) }));
  const index = buildIndex("/home/someone/.anywh/rooms/3f2c1b0e-aaaa-bbbb-cccc-0123456789ab", items);
  assert.ok(index.length <= INDEX_MAX_CHARS, `index is ${index.length} chars`);
  assert.ok(encode(index).length <= 2000, `index is ${encode(index).length} tokens`);
  assert.match(index, /file-399/);
  assert.doesNotMatch(index, /file-000/);
  assert.match(index, /older items? not listed/);
});

test("a normal room of twenty items is listed whole at about a thousand tokens or less", () => {
  const items = Array.from({ length: 20 }, (_, i) => item(`note-${i}.md`, i));
  const index = buildIndex("/r", items);
  assert.doesNotMatch(index, /not listed/);
  assert.ok(encode(index).length < 1200);
});

test("summarize skips markup and empty lines and cuts long ones at a word", () => {
  assert.equal(summarize("\n\n# Checkout redesign\nmore"), "Checkout redesign");
  assert.equal(summarize("---\n\n   \n"), "");
  const long = summarize(`${"word ".repeat(60)}`);
  assert.ok(long.length <= 111 && long.endsWith("…"));
});

test("the notice for items that arrived late lists a few and counts the rest", () => {
  const items = Array.from({ length: 7 }, (_, i) => item(`n${i}.md`, i));
  const notice = buildNotice(items, 2);
  assert.match(notice, /^New in the room's context since you started: `n0\.md`/);
  assert.match(notice, /and 5 more/);
});

test("estimateTokens is four characters to a token, rounded up", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(1), 1);
  assert.equal(estimateTokens(401), 101);
});
