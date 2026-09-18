import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { countTokens } from "./tokenizer.js";
import { listAssetFilesAcross, readFrontmatterDescription } from "./agentAssets.js";
import type { ContextAccounting, ContextRuleAccounting, ContextSkillAccounting, ContextSubagentAccounting } from "../runtimes/types.js";

/** Pure: the calibrated formula itself, against a raw token count already in
 * hand — no fs, no clock, so the unit tier can pin the arithmetic down
 * without touching disk. Rounded once, at the end, not per input. */
export function estimateRuleTokens(rawTokenCount: number, accounting: ContextRuleAccounting): number {
  return Math.round(rawTokenCount * accounting.multiplier + accounting.perFile);
}

/** Pure: Codex's skills formula — the description sum is already capped by
 * the caller (each entry truncated to `descriptionMaxTokens` before it ever
 * reaches here), so this is just the linear per-entry/header overhead on
 * top. Undefined input (zero entries) isn't this function's job to special
 * case — the caller never calls it for an empty list (see `readSkillTokens`),
 * since the measured formula's `header` term is the cost of the block
 * appearing at all, not a fixed tax paid even with nothing in it. */
export function estimateSkillsTokens(cappedDescriptionTokens: readonly number[], accounting: Pick<ContextSkillAccounting, "perEntry" | "header">): number {
  const sum = cappedDescriptionTokens.reduce((a, b) => a + b, 0);
  return sum + accounting.perEntry * cappedDescriptionTokens.length + accounting.header;
}

/** Pure: Claude's subagents formula — unlike skills, the multiplier applies
 * to the full description text (not ignored), fit against `cl100k_base`
 * independently of the Rules calibration but landing on a compatible
 * multiplier (1.0955 here vs. 1.1262 there), which is itself evidence the
 * factor is a property of the tokenizer proxy, not an artifact of either
 * measurement. */
export function estimateSubagentsTokens(descriptionTokenCounts: readonly number[], accounting: Pick<ContextSubagentAccounting, "multiplier" | "perEntry" | "header">): number {
  const total = descriptionTokenCounts.reduce((a, b) => a + b, 0);
  return Math.round(total * accounting.multiplier + accounting.perEntry * descriptionTokenCounts.length + accounting.header);
}

/** "Everything the baseline paid for that no category above could name" —
 * clamped to zero so a future category whose estimate overshoots the real
 * baseline (bad calibration, or a CLI version drifting from the constants
 * it was measured against) never reports a negative residual and confuses
 * the total this is supposed to reconcile against. */
export function computeResidual(baselineTokens: number, estimatedCategoriesTotal: number): number {
  return Math.max(0, baselineTokens - estimatedCategoriesTotal);
}

interface RulesCacheEntry {
  readonly mtimeMs: number;
  readonly tokens: number;
}

/** Keyed by absolute path, process-lifetime — a rule file's token cost
 * doesn't depend on which session asked, only on its own bytes at the time
 * they were last read. */
const rulesCache = new Map<string, RulesCacheEntry>();

/** Boundary: reads `cwd`'s rule file (if one exists) and tokenizes it with
 * the def's own encoding. Invalidated by `mtimeMs`, not a TTL — a rule file
 * can be rewritten mid-conversation (the agent itself edits its own
 * CLAUDE.md/AGENTS.md), and a stale estimate right after that would
 * visibly contradict what the agent just did. `undefined` means no such
 * file exists in this cwd, not "cost zero" — the caller decides what that
 * means for the category's visibility. */
export async function readRuleTokens(cwd: string, ruleFileName: string, accounting: ContextAccounting): Promise<number | undefined> {
  const path = join(cwd, ruleFileName);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  const cached = rulesCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.tokens;
  const text = readFileSync(path, "utf8");
  const rawCount = await countTokens(text, accounting.encoding);
  const tokens = estimateRuleTokens(rawCount, accounting.rules);
  rulesCache.set(path, { mtimeMs, tokens });
  return tokens;
}

/** Boundary: reads every skill this Codex-shaped def can see (across both
 * `cwd` and `home`, every dir the accounting declares), truncates each
 * description to `descriptionMaxTokens`, and applies the formula. `undefined`
 * with zero skills found — same "category doesn't exist right now" shape as
 * `readRuleTokens`'s missing-file case, not zero-with-a-header. */
export async function readSkillTokens(roots: readonly string[], accounting: ContextSkillAccounting): Promise<{ tokens: number; count: number } | undefined> {
  const files = listAssetFilesAcross(roots, accounting.dirs, "skill-folders");
  if (files.length === 0) return undefined;
  const capped: number[] = [];
  for (const file of files) {
    const description = readFrontmatterDescription(file);
    const raw = description ? await countTokens(description, "o200k_base") : 0;
    capped.push(Math.min(raw, accounting.descriptionMaxTokens));
  }
  return { tokens: estimateSkillsTokens(capped, accounting), count: files.length };
}

/** Boundary: the Claude-shaped mirror of `readSkillTokens` — flat `.md`
 * files instead of a skill's own subfolder, full descriptions (no
 * truncation), `cl100k_base` instead of `o200k_base`. */
export async function readSubagentTokens(roots: readonly string[], accounting: ContextSubagentAccounting): Promise<{ tokens: number; count: number } | undefined> {
  const files = listAssetFilesAcross(roots, accounting.dirs, "flat-md");
  if (files.length === 0) return undefined;
  const counts: number[] = [];
  for (const file of files) {
    const description = readFrontmatterDescription(file);
    counts.push(description ? await countTokens(description, "cl100k_base") : 0);
  }
  return { tokens: estimateSubagentsTokens(counts, accounting), count: files.length };
}

/** A `readdir` that finds nothing at all — the one real, measured signal
 * some CLIs use to inject a bigger "describe yourself" prompt block (see
 * `emptyDirectoryInflation`'s own doc comment). An unreadable `cwd` reads as
 * "not empty" rather than throwing: a session's cwd should always exist by
 * the time a breakdown is requested, and failing safe here means a
 * transient stat error never fabricates a cost that isn't real. */
function isCwdEmpty(cwd: string): boolean {
  try {
    return readdirSync(cwd).length === 0;
  } catch {
    return false;
  }
}

export interface ContextBreakdown {
  /** Absent when this cwd has no rule file at all — distinct from "0 tokens
   * of rules", which would be a real (if odd) file that tokenized to
   * nothing. */
  readonly rules?: { readonly tokens: number; readonly estimated: true };
  /** Absent when this def declares no `skills` accounting, or when none
   * were found on disk — both real "this category doesn't exist right now"
   * answers, not a zero to render. */
  readonly skills?: { readonly tokens: number; readonly estimated: true; readonly count: number };
  /** Absent when this def declares no `subagents` accounting (Codex), or
   * when none were found on disk. */
  readonly subagents?: { readonly tokens: number; readonly estimated: true; readonly count: number };
  /** Present only when this def's `emptyDirectoryInflation` is nonzero AND
   * the cwd is actually empty right now — both conditions, not either. */
  readonly emptyDirectory?: { readonly tokens: number; readonly estimated: true };
  /** Absent when the conversation's `baselineTokens` isn't known yet (no
   * turn has completed) — there is nothing to subtract the estimated
   * categories from. Marked exact "by construction": it's an exact baseline
   * minus every category this def could estimate, so it always reconciles
   * the total even though some of its own inputs are themselves estimates. */
  readonly residual?: { readonly tokens: number; readonly estimated: false };
}

/**
 * Computes what this session's def can currently name about its own
 * baseline. `baselineTokens` absent (no turn yet) still returns every other
 * category on its own — none of them need a live conversation, only a cwd
 * and (for skills/subagents) the agent's home directory.
 */
export async function computeContextBreakdown(opts: {
  readonly cwd: string;
  readonly home: string;
  readonly ruleFileName: string;
  readonly accounting: ContextAccounting;
  readonly baselineTokens?: number;
}): Promise<ContextBreakdown> {
  // Deduped: a session whose cwd IS the agent's home directory (opening a
  // session directly in `~`) would otherwise scan the same asset directory
  // twice and double-count every skill/subagent found there.
  const roots = [...new Set([opts.cwd, opts.home])];
  const rulesTokens = await readRuleTokens(opts.cwd, opts.ruleFileName, opts.accounting);
  const rules = rulesTokens !== undefined ? { tokens: rulesTokens, estimated: true as const } : undefined;

  const skillsResult = opts.accounting.skills ? await readSkillTokens(roots, opts.accounting.skills) : undefined;
  const skills = skillsResult ? { ...skillsResult, estimated: true as const } : undefined;

  const subagentsResult = opts.accounting.subagents ? await readSubagentTokens(roots, opts.accounting.subagents) : undefined;
  const subagents = subagentsResult ? { ...subagentsResult, estimated: true as const } : undefined;

  const emptyDirectory =
    opts.accounting.emptyDirectoryInflation > 0 && isCwdEmpty(opts.cwd)
      ? { tokens: opts.accounting.emptyDirectoryInflation, estimated: true as const }
      : undefined;

  const estimatedTotal = (rules?.tokens ?? 0) + (skills?.tokens ?? 0) + (subagents?.tokens ?? 0) + (emptyDirectory?.tokens ?? 0);
  const residual = opts.baselineTokens !== undefined ? { tokens: computeResidual(opts.baselineTokens, estimatedTotal), estimated: false as const } : undefined;

  return {
    ...(rules ? { rules } : {}),
    ...(skills ? { skills } : {}),
    ...(subagents ? { subagents } : {}),
    ...(emptyDirectory ? { emptyDirectory } : {}),
    ...(residual ? { residual } : {}),
  };
}
