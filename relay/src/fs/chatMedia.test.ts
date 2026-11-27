import { test } from "node:test";
import assert from "node:assert/strict";
import { chatMediaEtag, chatMediaOf, etagMatches, parseByteRange } from "./chatMedia.js";

test("chatMediaOf: images and the videos a webview plays, by extension, case-insensitive", () => {
  assert.deepEqual(chatMediaOf("/tmp/shot.PNG"), { mime: "image/png", kind: "image" });
  assert.deepEqual(chatMediaOf("/tmp/run.mov"), { mime: "video/quicktime", kind: "video" });
  assert.equal(chatMediaOf("/tmp/clip.mkv"), undefined);
  assert.equal(chatMediaOf("/home/me/.env"), undefined);
  assert.equal(chatMediaOf("/tmp/png"), undefined);
});

test("parseByteRange: no header, another unit or a malformed value serves the whole file", () => {
  assert.equal(parseByteRange(undefined, 100), undefined);
  assert.equal(parseByteRange("items=0-1", 100), undefined);
  assert.equal(parseByteRange("bytes=abc", 100), undefined);
  assert.equal(parseByteRange("bytes=-", 100), undefined);
});

test("parseByteRange: several ranges at once fall back to the whole file", () => {
  assert.equal(parseByteRange("bytes=0-1,5-9", 100), undefined);
});

test("parseByteRange: an open range runs to the last byte, the first probe a <video> sends", () => {
  assert.deepEqual(parseByteRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=40-", 100), { start: 40, end: 99 });
});

test("parseByteRange: an end past the file is clamped to its last byte", () => {
  assert.deepEqual(parseByteRange("bytes=0-1", 100), { start: 0, end: 1 });
  assert.deepEqual(parseByteRange("bytes=90-500", 100), { start: 90, end: 99 });
});

test("parseByteRange: a suffix range is the last N bytes, the whole file when N is larger", () => {
  assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-500", 100), { start: 0, end: 99 });
});

test("parseByteRange: a start past the end, an inverted range, a zero suffix or an empty file is unsatisfiable", () => {
  assert.equal(parseByteRange("bytes=100-", 100), null);
  assert.equal(parseByteRange("bytes=50-10", 100), null);
  assert.equal(parseByteRange("bytes=-0", 100), null);
  assert.equal(parseByteRange("bytes=0-", 0), null);
});

test("chatMediaEtag: a rewrite under the same name changes the tag", () => {
  const before = chatMediaEtag({ size: 2048, mtimeMs: 1_700_000_000_000.5 });
  assert.equal(before, chatMediaEtag({ size: 2048, mtimeMs: 1_700_000_000_000.9 }));
  assert.notEqual(before, chatMediaEtag({ size: 2048, mtimeMs: 1_700_000_000_123 }));
  assert.notEqual(before, chatMediaEtag({ size: 2049, mtimeMs: 1_700_000_000_000 }));
});

test("etagMatches: the exact tag, its weak twin, one of a list, or *", () => {
  const etag = '"800-18bcfe56800"';
  assert.equal(etagMatches(undefined, etag), false);
  assert.equal(etagMatches(etag, etag), true);
  assert.equal(etagMatches(`W/${etag}`, etag), true);
  assert.equal(etagMatches(`"other", ${etag}`, etag), true);
  assert.equal(etagMatches("*", etag), true);
  assert.equal(etagMatches('"other"', etag), false);
});
