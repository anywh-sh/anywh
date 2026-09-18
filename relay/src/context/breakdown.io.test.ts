import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeContextBreakdown, estimateRuleTokens, readRuleTokens, readSkillTokens, readSubagentTokens } from "./breakdown.js";
import { countTokens } from "./tokenizer.js";
import type { ContextAccounting, ContextSkillAccounting, ContextSubagentAccounting } from "../runtimes/types.js";

const CLAUDE_ACCOUNTING: ContextAccounting = {
  encoding: "cl100k_base",
  rules: { multiplier: 1.1262, perFile: 83 },
  emptyDirectoryInflation: 2233,
};

const CODEX_SKILLS_ACCOUNTING: ContextSkillAccounting = {
  descriptionMaxTokens: 180,
  perEntry: 23,
  header: 19,
  dirs: [".codex/skills", ".agents/skills"],
};

const CLAUDE_SUBAGENTS_ACCOUNTING: ContextSubagentAccounting = {
  multiplier: 1.0955,
  perEntry: 12.7,
  header: 2,
  dirs: [".claude/agents"],
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
    const breakdown = await computeContextBreakdown({ cwd: dir, home: dir, ruleFileName: "CLAUDE.md", accounting: CLAUDE_ACCOUNTING });
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
    const breakdown = await computeContextBreakdown({ cwd: dir, home: dir, ruleFileName: "CLAUDE.md", accounting: CLAUDE_ACCOUNTING, baselineTokens: 50000 });
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
    // An unrelated file, not a rule file — keeps the cwd non-empty so this
    // test isolates "no rule file" from the separate emptyDirectory effect
    // below (an empty tmpdir is not a neutral control, see that test).
    writeFileSync(join(dir, "note.txt"), "hello");
    const breakdown = await computeContextBreakdown({ cwd: dir, home: dir, ruleFileName: "CLAUDE.md", accounting: CLAUDE_ACCOUNTING, baselineTokens: 21398 });
    assert.equal(breakdown.rules, undefined);
    assert.equal(breakdown.emptyDirectory, undefined);
    assert.equal(breakdown.residual?.tokens, 21398);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeContextBreakdown reports emptyDirectory only when the accounting declares it AND the cwd is actually empty", async () => {
  const dir = makeWorkDir();
  try {
    const breakdown = await computeContextBreakdown({ cwd: dir, home: dir, ruleFileName: "CLAUDE.md", accounting: CLAUDE_ACCOUNTING, baselineTokens: 21398 });
    assert.deepEqual(breakdown.emptyDirectory, { tokens: 2233, estimated: true });
    assert.equal(breakdown.residual?.tokens, 21398 - 2233);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeContextBreakdown never reports emptyDirectory for a def with emptyDirectoryInflation of 0 (Codex), even on an empty cwd", async () => {
  const dir = makeWorkDir();
  try {
    const codexAccounting: ContextAccounting = { encoding: "o200k_base", rules: { multiplier: 1.0, perFile: 21 }, emptyDirectoryInflation: 0 };
    const breakdown = await computeContextBreakdown({ cwd: dir, home: dir, ruleFileName: "AGENTS.md", accounting: codexAccounting, baselineTokens: 13955 });
    assert.equal(breakdown.emptyDirectory, undefined);
    assert.equal(breakdown.residual?.tokens, 13955);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSkillTokens is undefined when no skill directories exist", async () => {
  const dir = makeWorkDir();
  try {
    assert.equal(await readSkillTokens([dir], CODEX_SKILLS_ACCOUNTING), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSkillTokens reads real skill descriptions across both declared dirs, capping at descriptionMaxTokens", async () => {
  const dir = makeWorkDir();
  try {
    mkdirSync(join(dir, ".codex", "skills", "one"), { recursive: true });
    writeFileSync(join(dir, ".codex", "skills", "one", "SKILL.md"), "---\ndescription: a short skill description\n---\n");
    mkdirSync(join(dir, ".agents", "skills", "two"), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", "two", "SKILL.md"), "---\ndescription: another short one\n---\n");

    const result = await readSkillTokens([dir], CODEX_SKILLS_ACCOUNTING);
    assert.ok(result);
    assert.equal(result.count, 2);

    // Recomputed independently against the real tokenizer, not a hardcoded
    // magic number — both descriptions are well under the 180-token cap.
    const oneTokens = await countTokens("a short skill description", "o200k_base");
    const twoTokens = await countTokens("another short one", "o200k_base");
    const expected = oneTokens + twoTokens + CODEX_SKILLS_ACCOUNTING.perEntry * 2 + CODEX_SKILLS_ACCOUNTING.header;
    assert.equal(result.tokens, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSubagentTokens is undefined when no subagent directory exists", async () => {
  const dir = makeWorkDir();
  try {
    assert.equal(await readSubagentTokens([dir], CLAUDE_SUBAGENTS_ACCOUNTING), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSubagentTokens combines project and home dirs into one count", async () => {
  const projectDir = makeWorkDir();
  const homeDir = makeWorkDir();
  try {
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(projectDir, ".claude", "agents", "reviewer.md"), "---\ndescription: reviews pull requests carefully\n---\n");
    mkdirSync(join(homeDir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(homeDir, ".claude", "agents", "planner.md"), "---\ndescription: plans multi-step work\n---\n");

    const result = await readSubagentTokens([projectDir, homeDir], CLAUDE_SUBAGENTS_ACCOUNTING);
    assert.ok(result);
    assert.equal(result.count, 2);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("computeContextBreakdown wires skills/subagents end to end, only for a def that declares them", async () => {
  const dir = makeWorkDir();
  try {
    writeFileSync(join(dir, "note.txt"), "keeps the cwd non-empty");
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "reviewer.md"), "---\ndescription: reviews pull requests\n---\n");

    const claudeWithSubagents: ContextAccounting = { ...CLAUDE_ACCOUNTING, subagents: CLAUDE_SUBAGENTS_ACCOUNTING };
    const breakdown = await computeContextBreakdown({ cwd: dir, home: dir, ruleFileName: "CLAUDE.md", accounting: claudeWithSubagents, baselineTokens: 100000 });
    assert.ok(breakdown.subagents);
    assert.equal(breakdown.subagents.count, 1);
    assert.equal(breakdown.skills, undefined, "Claude's accounting declares no skills");
    assert.equal(breakdown.residual?.tokens, 100000 - breakdown.subagents.tokens);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
