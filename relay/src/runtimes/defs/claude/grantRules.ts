// What a human's approval of a refused tool call lets the next Claude turn do.
// Measured against Claude Code 2.1.303:
//   - a path-specific rule only grants as `Edit(//absolute/path)` (it covers
//     Write too; `Write(/abs)` does not grant), and `Write`/`Edit` with no
//     argument grant every call of the tool;
//   - an exact `Bash(<command>)` rule grants a plain command, but not one with
//     an output redirect (the model is asked again for the very same command).
// A grant is narrow when a rule can name the one approved call, broad when
// only the whole tool can be named. A broad grant lasts for the whole turn, so
// it is only given when nothing of that tool was refused (`planDeferredGrants`).
import { lstatSync, realpathSync } from "node:fs";
import { dirname, posix } from "node:path";
import type { ToolGrant } from "../../types.js";

export interface GrantRule {
  rule: string;
  /** The rule names a whole tool, not the approved call. */
  broad: boolean;
}

// Characters that mean something in a permission rule's argument (wildcards,
// grouping, the list separator) or that no rule can spell (line breaks).
const RULE_SPECIAL = /[*?[\]{}(),\\\n\r]/;
// Shell syntax that makes a command more than one thing to check (redirects,
// pipes, lists, substitutions).
const SHELL_OPERATORS = /[<>|&;`$]/;

function stringField(input: unknown, name: string): string | undefined {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** A path a `Edit(//…)` rule can name without naming more than that file:
 * absolute, already canonical (no `.`/`..`/`//` segments, no trailing slash),
 * free of glob and rule syntax, not a symlink, and not reached through a
 * symlinked directory (the rule would then cover whatever the link points at). */
function isPlainAbsolutePath(path: string): boolean {
  if (!path.startsWith("/") || path === "/" || path.endsWith("/") || posix.normalize(path) !== path || RULE_SPECIAL.test(path)) return false;
  try {
    if (lstatSync(path).isSymbolicLink()) return false;
  } catch {
    // Not there yet (a Write creating it): nothing to resolve.
  }
  try {
    return realpathSync(dirname(path)) === dirname(path);
  } catch {
    return true;
  }
}

/** The rule that would let `grant` run, or `undefined` when no rule can say it
 * safely (the model is then asked again rather than given something wider). */
export function grantRuleFor({ tool, input }: ToolGrant): GrantRule | undefined {
  if (tool === "ExitPlanMode") return undefined;
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const path = stringField(input, "file_path");
    return path !== undefined && isPlainAbsolutePath(path) ? { rule: `Edit(/${path})`, broad: false } : undefined;
  }
  if (tool === "Bash") {
    const command = stringField(input, "command");
    if (command === undefined || command.trim() === "") return undefined;
    return RULE_SPECIAL.test(command) || SHELL_OPERATORS.test(command) ? { rule: "Bash", broad: true } : { rule: `Bash(${command})`, broad: false };
  }
  return { rule: tool, broad: true };
}

/** The `--allowedTools` rules for calls already cleared to be granted. */
export function buildGrantRules(grants: readonly ToolGrant[]): string[] {
  const rules = new Set<string>();
  for (const grant of grants) {
    const found = grantRuleFor(grant);
    if (found) rules.add(found.rule);
  }
  return [...rules];
}

export type GrantOutcome = "granted" | "asked-again" | "denied";

/**
 * Which approved calls actually get a permission. A narrow rule is given to
 * its own call. A broad one covers every call of the tool for the turn, so it
 * is only given when ALL pending calls of that tool in the prompt were
 * approved: approving `ls | head` must not let a denied `rm -rf` of the same
 * prompt run. An approved call left without a permission ("asked-again") will
 * be asked about again.
 */
export function planDeferredGrants(calls: readonly (ToolGrant & { approved: boolean })[]): GrantOutcome[] {
  const refusedTools = new Set(calls.filter((call) => !call.approved).map((call) => call.tool));
  return calls.map((call) => {
    if (!call.approved) return "denied";
    // Needs no rule: approving it is what leaves plan mode.
    if (call.tool === "ExitPlanMode") return "granted";
    const found = grantRuleFor(call);
    if (!found || (found.broad && refusedTools.has(call.tool))) return "asked-again";
    return "granted";
  });
}
