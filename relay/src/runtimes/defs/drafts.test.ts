import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCoherent } from "../registry.js";
import { acpRuntimeDraft } from "./acp.js";

// ACP is the one remaining shape-proving draft — it exists to validate
// ../types.ts against a third agent shape before any engine consumes the
// contract, same reasoning codex.ts's own draft stage used to (see
// codex.test.ts now that it's a real def). Not registered anywhere; running
// assertCoherent against it is the whole point of writing it.

test("acpRuntimeDraft is coherent except for its declared env.strip gap", () => {
  const issues = assertCoherent(acpRuntimeDraft);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /env\.strip is empty/);
});
