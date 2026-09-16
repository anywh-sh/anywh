import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCoherent } from "../registry.js";
import { codexRuntimeDraft } from "./codex.js";
import { acpRuntimeDraft } from "./acp.js";

// These two drafts exist to validate ../types.ts against a second and
// third agent shape before any engine consumes the contract — this test
// is that validation. Neither draft is registered anywhere; running
// assertCoherent against them is the whole point of writing them.

test("codexRuntimeDraft is coherent", () => {
  assert.deepEqual(assertCoherent(codexRuntimeDraft), []);
});

test("acpRuntimeDraft is coherent except for its declared env.strip gap", () => {
  const issues = assertCoherent(acpRuntimeDraft);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /env\.strip is empty/);
});
