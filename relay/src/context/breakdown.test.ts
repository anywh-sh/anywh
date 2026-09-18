import { test } from "node:test";
import assert from "node:assert/strict";
import { computeResidual, estimateRuleTokens, estimateSkillsTokens, estimateSubagentsTokens } from "./breakdown.js";

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

// ---- skills (Codex's real fit: descriptionMaxTokens 180, perEntry 23, header 19) ----

const CODEX_SKILLS = { descriptionMaxTokens: 180, perEntry: 23, header: 19 };

test("estimateSkillsTokens matches Codex's real single-skill probe (35-token description)", () => {
  assert.equal(estimateSkillsTokens([35], CODEX_SKILLS), 77);
});

test("estimateSkillsTokens matches Codex's real 12-skill probe (35 tokens each)", () => {
  assert.equal(estimateSkillsTokens(Array(12).fill(35) as number[], CODEX_SKILLS), 715);
});

test("estimateSkillsTokens matches Codex's real probe for a description at the truncation cap", () => {
  // A 390-token and a 1,170-token description both measured identically —
  // the caller truncates to descriptionMaxTokens before calling this, so
  // both arrive here as 180.
  assert.equal(estimateSkillsTokens([180], CODEX_SKILLS), 222);
});

// ---- subagents (Claude's real fit: multiplier 1.0955, perEntry 12.7, header 2) ----

const CLAUDE_SUBAGENTS = { multiplier: 1.0955, perEntry: 12.7, header: 2 };

test("estimateSubagentsTokens matches Claude's real single-agent probes", () => {
  assert.equal(estimateSubagentsTokens([35], CLAUDE_SUBAGENTS), 53);
  assert.equal(estimateSubagentsTokens([391], CLAUDE_SUBAGENTS), 443);
});

test("estimateSubagentsTokens is within a token of Claude's real 12-agent probe", () => {
  // The real probe measured 614 for 12 agents at 35 tokens each. def.ts's
  // constants are rounded to 4 significant figures for readability rather
  // than the unrounded exact fit (390/356, ...), so this reproduces the
  // real probe within 1 token rather than exactly — the expected floor
  // once the coefficients themselves are rounded.
  const result = estimateSubagentsTokens(Array(12).fill(35) as number[], CLAUDE_SUBAGENTS);
  assert.ok(Math.abs(result - 614) <= 1, `expected within 1 token of the real 614 probe, got ${result}`);
});
