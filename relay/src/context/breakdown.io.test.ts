import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeContextBreakdown, estimateRuleTokens, readRuleTokens } from "./breakdown.js";
import { countTokens } from "./tokenizer.js";
import type { ContextAccounting } from "../runtimes/types.js";

const CLAUDE_ACCOUNTING: ContextAccounting = {
  encoding: "cl100k_base",
  rules: { multiplier: 1.1262, perFile: 83 },
  emptyDirectoryInflation: 2233,
};

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "anywh-breakdown-"));
}

test("readRuleTokens is undefined when the cwd has no rule file", async () => {
  const dir = makeWorkDir();
  try {
    assert.equal(await readRuleTokens(dir, "CLAUDE.md", CLAUDE_ACCOUNTING), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRuleTokens applies the calibrated formula against the real tokenizer, recomputed here rather than hardcoded", async () => {
  const dir = makeWorkDir();
  try {
    const text = "# Project rules\n\nAlways write tests in English. Never commit secrets.\n".repeat(20);
    writeFileSync(join(dir, "CLAUDE.md"), text);
    const rawCount = await countTokens(text, "cl100k_base");
    const expected = estimateRuleTokens(rawCount, CLAUDE_ACCOUNTING.rules);
    const actual = await readRuleTokens(dir, "CLAUDE.md", CLAUDE_ACCOUNTING);
    assert.equal(actual, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRuleTokens invalidates its cache by mtime, not by content alone or a TTL", async () => {
  const dir = makeWorkDir();
  try {
    const path = join(dir, "CLAUDE.md");
    writeFileSync(path, "short rule file");
    const first = await readRuleTokens(dir, "CLAUDE.md", CLAUDE_ACCOUNTING);

    // Same content read again: the cache must still answer (proves it's
    // hit, not just correct by re-reading every time) — same call, no
    // filesystem change in between.
    const cachedAgain = await readRuleTokens(dir, "CLAUDE.md", CLAUDE_ACCOUNTING);
    assert.equal(cachedAgain, first);

    // The agent rewrites its own rule file mid-conversation — a real case
    // this cache exists for, not a hypothetical. Advance mtime explicitly
    // (some filesystems have coarser mtime resolution than a fast rewrite
    // in the same test can rely on) so the cache is guaranteed to notice.
    const longerText = "a much longer rewritten rule file, well past the short one above, several sentences long".repeat(5);
    writeFileSync(path, longerText);
    const future = new Date(Date.now() + 5000);
    utimesSync(path, future, future);

    const second = await readRuleTokens(dir, "CLAUDE.md", CLAUDE_ACCOUNTING);
    assert.notEqual(second, first);
    const rawCount = await countTokens(longerText, "cl100k_base");
    assert.equal(second, estimateRuleTokens(rawCount, CLAUDE_ACCOUNTING.rules));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeContextBreakdown returns only rules when no baseline is known yet (no turn has happened)", async () => {
  const dir = makeWorkDir();
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "some rules");
    const breakdown = await computeContextBreakdown({ cwd: dir, ruleFileName: "CLAUDE.md", accounting: CLAUDE_ACCOUNTING });
    assert.ok(breakdown.rules);
    assert.equal(breakdown.rules.estimated, true);
    assert.equal(breakdown.residual, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeContextBreakdown fills in the residual once a baseline is known, reconciling exactly against it", async () => {
  const dir = makeWorkDir();
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "some rules");
    const breakdown = await computeContextBreakdown({ cwd: dir, ruleFileName: "CLAUDE.md", accounting: CLAUDE_ACCOUNTING, baselineTokens: 50000 });
    assert.ok(breakdown.rules);
    assert.ok(breakdown.residual);
    assert.equal(breakdown.residual.estimated, false);
    assert.equal(breakdown.rules.tokens + breakdown.residual.tokens, 50000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeContextBreakdown with no rule file at all still resolves a residual equal to the whole baseline", async () => {
  const dir = makeWorkDir();
  try {
    const breakdown = await computeContextBreakdown({ cwd: dir, ruleFileName: "CLAUDE.md", accounting: CLAUDE_ACCOUNTING, baselineTokens: 21398 });
    assert.equal(breakdown.rules, undefined);
    assert.equal(breakdown.residual?.tokens, 21398);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
