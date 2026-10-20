import { test } from "node:test";
import assert from "node:assert/strict";
import { stripRelayNote, withRelayNote } from "./relayNote.js";

test("a note is appended behind a marker and stripped back off", () => {
  const prompt = withRelayNote("never mind", "the approval was withdrawn");
  assert.notEqual(prompt, "never mind");
  assert.match(prompt, /the approval was withdrawn$/);
  assert.equal(stripRelayNote(prompt), "never mind");
});

test("text without a note, or with an empty prefix, is handled", () => {
  assert.equal(stripRelayNote("plain"), "plain");
  assert.equal(stripRelayNote(withRelayNote("", "n")), "");
});
