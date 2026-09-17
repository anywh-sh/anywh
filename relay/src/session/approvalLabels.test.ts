import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDecisionLabel } from "./approvalLabels.js";

test("resolves each known Codex decision key to its English label", () => {
  assert.equal(resolveDecisionLabel("codex.decision.accept"), "Accept");
  assert.equal(resolveDecisionLabel("codex.decision.acceptForSession"), "Accept for this session");
  assert.equal(resolveDecisionLabel("codex.decision.decline"), "Decline");
  assert.equal(resolveDecisionLabel("codex.decision.cancel"), "Cancel");
});

test("falls back to the raw key for one it doesn't recognize", () => {
  assert.equal(resolveDecisionLabel("codex.decision.somethingNew"), "codex.decision.somethingNew");
});
