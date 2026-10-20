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
import { basename, dirname, posix, resolve } from "node:path";
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
  // The nearest directory that exists must be its own real path: a symlink
  // further up, above directories the write would create, still redirects it.
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      return realpathSync(dir) === dir;
    } catch {
      if (dir === "/") return true;
    }
  }
}

/** The rule that would let `grant` run, or `undefined` when no rule can say it
 * safely (the model is then asked again rather than given something wider). */
export function grantRuleFor({ tool, input }: ToolGrant): GrantRule | undefined {
  if (tool === "ExitPlanMode") return undefined;
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const path = stringField(input, "file_path");
    if (path === undefined) return undefined;
    if (isPlainAbsolutePath(path)) return { rule: `Edit(/${path})`, broad: false };
    // No rule can name this one file (rule syntax in the name, a symlink in
    // the way, a relative or non-canonical path): only the tool can be
    // granted, under the same condition as any broad grant.
    return { rule: tool === "MultiEdit" ? "Edit" : tool, broad: true };
  }
  if (tool === "Bash") {
    const command = stringField(input, "command");
    if (command === undefined || command.trim() === "") return undefined;
    return RULE_SPECIAL.test(command) || SHELL_OPERATORS.test(command) ? { rule: "Bash", broad: true } : { rule: `Bash(${command})`, broad: false };
  }
  return { rule: tool, broad: true };
}

/** The `--allowedTools` rules for calls already cleared to be granted. A
 * grant that carries the rule the session decided on uses it as is. */
export function buildGrantRules(grants: readonly ToolGrant[]): string[] {
  const rules = new Set<string>();
  for (const grant of grants) {
    const rule = grant.rule ?? grantRuleFor(grant)?.rule;
    if (rule) rules.add(rule);
  }
  return [...rules];
}

export type GrantOutcome = "granted" | "asked-again" | "denied";

/** The edit tools overlap (`Edit` covers `Write`, and the notebook tool), so a
 * refusal of one is a refusal for all of them. */
function groupOf(tool: string): string {
  return tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit" ? "file-edit" : tool;
}

/** What a broad grant for `tool` allows, as the approval card says it. */
export function broadGrantLabel(tool: string): string {
  return groupOf(tool);
}

/**
 * The rule to use for a call whose card was shown with `stored`. The stored
 * rule is what the person saw and decided on, so it is used as is; the call is
 * looked at again only to be safe: if the rule it would get now differs, the
 * result can only be narrower (a broad card whose call is now narrow), never
 * wider, and anything else gets no rule (the model is asked again). A card
 * stored without a rule is never given a broad one it did not warn about.
 */
export function resolveGrant(stored: GrantRule | undefined, call: ToolGrant): GrantRule | undefined {
  const fresh = grantRuleFor(call);
  if (!stored) return fresh && !fresh.broad ? fresh : undefined;
  if (!fresh) return undefined;
  if (fresh.rule === stored.rule && fresh.broad === stored.broad) return stored;
  if (stored.broad && !fresh.broad) return fresh;
  return undefined;
}

/** What a call acts on, spelled one canonical way: a file by its resolved
 * path (relative to `cwd`, symlinks resolved when they can be), a Bash call by
 * its command text. */
function targetOf({ tool, input }: ToolGrant, cwd: string): string | undefined {
  if (tool === "Bash") {
    const command = stringField(input, "command");
    return command === undefined ? undefined : `bash:${command}`;
  }
  const path = stringField(input, tool === "NotebookEdit" ? "notebook_path" : "file_path");
  if (path === undefined || groupOf(tool) !== "file-edit") return undefined;
  const full = posix.normalize(resolve(cwd, path));
  try {
    return `file:${realpathSync(full)}`;
  } catch {
    try {
      return `file:${posix.join(realpathSync(dirname(full)), basename(full))}`;
    } catch {
      return `file:${full}`;
    }
  }
}

/**
 * Whether `call` is one of the calls cleared by `grants`, for an agent whose
 * CLI cannot be given `--allowedTools` for a turn (a long-lived one in the
 * agent host): the relay answers its permission requests itself, and answers
 * yes to these. Same reach as the rules `buildGrantRules` would have given: a
 * rule that names a whole tool covers every call of it (the edit tools
 * together), one that names a call covers that one.
 */
export function grantsAllow(grants: readonly ToolGrant[], call: ToolGrant, cwd: string): boolean {
  return grants.some((grant) => {
    if (grant.tool === "ExitPlanMode") return call.tool === "ExitPlanMode";
    const rule = grant.rule ?? grantRuleFor(grant)?.rule;
    if (rule === undefined) return false;
    if (!rule.includes("(")) return groupOf(call.tool) === groupOf(grant.tool);
    const wanted = targetOf(grant, cwd);
    return wanted !== undefined && targetOf(call, cwd) === wanted;
  });
}

export interface PlannedCall extends ToolGrant {
  approved: boolean;
  /** The rule stored with the card for this call. */
  stored?: GrantRule;
}

/**
 * Which approved calls actually get a permission. A narrow rule is given to
 * its own call. A broad one covers every call of the tool for the turn, so it
 * is only given when nothing of that tool is still undecided or refused:
 * approving `ls | head` must not let a denied `rm -rf` of the same prompt, or
 * one waiting behind this card, run. A narrow rule is not given when a
 * refused or waiting call acts on the same target, however it is spelled. An
 * approved call left without a permission ("asked-again") will be asked about
 * again.
 */
export function planDeferredGrants(calls: readonly PlannedCall[], options: { waiting?: readonly ToolGrant[]; cwd?: string } = {}): GrantOutcome[] {
  const cwd = options.cwd ?? "/";
  const blockers: ToolGrant[] = [...calls.filter((call) => !call.approved), ...(options.waiting ?? [])];
  const blockedGroups = new Set(blockers.map((call) => groupOf(call.tool)));
  const blockedTargets = new Set(blockers.flatMap((call) => targetOf(call, cwd) ?? []));
  return calls.map((call) => {
    if (!call.approved) return "denied";
    // Needs no rule: approving it is what leaves plan mode.
    if (call.tool === "ExitPlanMode") return "granted";
    const found = resolveGrant(call.stored, call);
    if (!found) return "asked-again";
    if (found.broad) return blockedGroups.has(groupOf(call.tool)) ? "asked-again" : "granted";
    const target = targetOf(call, cwd);
    return target !== undefined && blockedTargets.has(target) ? "asked-again" : "granted";
  });
}
