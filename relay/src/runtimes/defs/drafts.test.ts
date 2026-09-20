import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCoherent } from "../registry.js";
import { acpRuntimeDraft } from "./acp.js";

// ACP is the one remaining shape-proving draft — it exists to validate
// ../types.ts against a third agent shape before any engine consumes the
// contract, same reasoning codex.ts's own draft stage used to (see
// codex.test.ts now that it's a real def). Not registered anywhere; running
// assertCoherent against it is the whole point of writing it.

// Two issues, not one, and both are the same fact stated twice: ACP is a
// transport, not an agent. It has no credential of its own to strip and no
// config home of its own to carry, and a concrete def for an ACP-speaking
// agent fills both in together. Asserting the exact count (rather than
// "at least the env.strip one") is what makes a *third*, accidental gap —
// a real incoherence introduced by a later edit — fail this test instead
// of hiding behind the two declared ones.
test("acpRuntimeDraft is coherent except for the two gaps it declares: no credential, no config home", () => {
  const issues = assertCoherent(acpRuntimeDraft).map((issue) => issue.message);
  assert.equal(issues.length, 2, issues.join("; "));
  assert.ok(issues.some((message) => /env\.strip is empty/.test(message)));
  assert.ok(issues.some((message) => /portability\.authoredPaths is empty/.test(message)));
});
