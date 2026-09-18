import { test } from "node:test";
import assert from "node:assert/strict";
import { computeResidual, estimateRuleTokens } from "./breakdown.js";

test("estimateRuleTokens applies the calibrated multiplier and per-file overhead, rounded once", () => {
  // Claude's own fit (see claude/def.ts's contextAccounting comment):
  // 1.1262 * cl100k + 83, checked against a real 9,487-token file whose raw
  // cl100k count was 8,353.
  assert.equal(estimateRuleTokens(8353, { multiplier: 1.1262, perFile: 83 }), 9490);
});

test("estimateRuleTokens with a 1.0 multiplier and 0 perFile is a pass-through (Codex's real fit)", () => {
  assert.equal(estimateRuleTokens(7648, { multiplier: 1.0, perFile: 21 }), 7669);
});

test("computeResidual is baseline minus every estimated category, clamped at zero", () => {
  assert.equal(computeResidual(45448, 9490), 35958);
});

test("computeResidual never goes negative when an estimate overshoots the real baseline", () => {
  // A future category badly calibrated (or a CLI version drift) could, in
  // principle, estimate more than the whole baseline it's a slice of — the
  // residual has to absorb that as zero, not a negative number that would
  // make the total under-report.
  assert.equal(computeResidual(1000, 5000), 0);
});

test("computeResidual with nothing estimated yet returns the whole baseline", () => {
  assert.equal(computeResidual(45448, 0), 45448);
});
