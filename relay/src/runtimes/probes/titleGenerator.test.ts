import { test } from "node:test";
import assert from "node:assert/strict";

import { fallbackTitle } from "./titleGenerator.js";

/**
 * `generateTitle` itself spawns `claude`, so only its fallback is reachable
 * here — which is fine, because the fallback is where the interesting rule
 * lives: what a session is called when there was nothing to name it after.
 */
test("names the session after the prompt when there is one", () => {
  assert.equal(fallbackTitle("  fix   the login  bug "), "fix the login bug");
});

test("truncates a pasted wall of text instead of titling with all of it", () => {
  const title = fallbackTitle("x".repeat(200));
  assert.equal(title?.length, 61);
  assert.ok(title?.endsWith("…"));
});

test("leaves the session untitled when the prompt has no text to salvage", () => {
  // Null, not a stand-in name. A title is persisted, so a stand-in written
  // here would keep whatever language this file was written in forever —
  // while the client draws its own "untitled" label in the language the user
  // actually picked.
  assert.equal(fallbackTitle("   \n\t "), null);
  assert.equal(fallbackTitle(""), null);
});
