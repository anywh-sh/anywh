import { test } from "node:test";
import assert from "node:assert/strict";
import { stripRelayNote, WITHDRAWN_APPROVAL_NOTE, withRelayNote } from "./relayNote.js";

test("a known note is appended behind a marker and stripped back off", () => {
  const prompt = withRelayNote("never mind", WITHDRAWN_APPROVAL_NOTE);
  assert.notEqual(prompt, "never mind");
  assert.equal(stripRelayNote(prompt), "never mind");
  assert.equal(stripRelayNote(withRelayNote("", WITHDRAWN_APPROVAL_NOTE)), "");
});

test("text a person wrote is never cut, even when it contains the marker", () => {
  for (const text of [
    "plain",
    "see this log:\n\n[anywh-note] something else entirely",
    "ends with the marker:\n\n[anywh-note] ",
    `${withRelayNote("a", "an unknown note")} and more after`,
    `quoting it: ${withRelayNote("a", WITHDRAWN_APPROVAL_NOTE)} but then more text`,
  ]) {
    assert.equal(stripRelayNote(text), text);
  }
});
