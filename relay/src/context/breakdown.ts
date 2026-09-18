import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { countTokens } from "./tokenizer.js";
import type { ContextAccounting, ContextRuleAccounting } from "../runtimes/types.js";

/** Pure: the calibrated formula itself, against a raw token count already in
 * hand — no fs, no clock, so the unit tier can pin the arithmetic down
 * without touching disk. Rounded once, at the end, not per input. */
export function estimateRuleTokens(rawTokenCount: number, accounting: ContextRuleAccounting): number {
  return Math.round(rawTokenCount * accounting.multiplier + accounting.perFile);
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

export interface ContextBreakdown {
  /** Absent when this cwd has no rule file at all — distinct from "0 tokens
   * of rules", which would be a real (if odd) file that tokenized to
   * nothing. */
  readonly rules?: { readonly tokens: number; readonly estimated: true };
  /** Absent when the conversation's `baselineTokens` isn't known yet (no
   * turn has completed) — there is nothing to subtract the rules estimate
   * from. Marked exact "by construction": it's an exact baseline minus
   * every category this def could estimate, so it always reconciles the
   * total even though one of its own inputs is itself an estimate. */
  readonly residual?: { readonly tokens: number; readonly estimated: false };
}

/**
 * Computes what this session's def can currently name about its own
 * baseline. `baselineTokens` absent (no turn yet) still returns the `rules`
 * estimate on its own — reading a project's rule file needs nothing from a
 * live conversation, only a cwd.
 */
export async function computeContextBreakdown(opts: {
  readonly cwd: string;
  readonly ruleFileName: string;
  readonly accounting: ContextAccounting;
  readonly baselineTokens?: number;
}): Promise<ContextBreakdown> {
  const rulesTokens = await readRuleTokens(opts.cwd, opts.ruleFileName, opts.accounting);
  const rules = rulesTokens !== undefined ? { tokens: rulesTokens, estimated: true as const } : undefined;
  const residual =
    opts.baselineTokens !== undefined ? { tokens: computeResidual(opts.baselineTokens, rulesTokens ?? 0), estimated: false as const } : undefined;
  return { ...(rules ? { rules } : {}), ...(residual ? { residual } : {}) };
}
