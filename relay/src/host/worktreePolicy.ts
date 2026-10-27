// The rules of the worktrees anywh creates for agents, with nothing but the
// facts handed in: how they are named, which records the relay may ever touch,
// and what to do with one when cleanup is asked. A worktree is removed only on
// evidence its work is safe elsewhere; with none, it is kept and the reason
// is said. The one way past that is the person's explicit "discard anyway".
//
// Pure: no I/O. The git calls that produce the facts are in worktreeGit.ts.
import { join, relative, resolve, sep } from "node:path";

/** Every branch the relay creates starts with this; so does nothing it
 * leaves alone. */
export const WORKTREE_BRANCH_PREFIX = "anywh/";

export type WorktreeState =
  /** The intention is recorded; `git worktree add` may or may not have run. */
  | "creating"
  | "created"
  /** Cleanup was asked and refused: the work is not safe elsewhere. */
  | "retained"
  /** Cleanup was decided; the removal may be half done. */
  | "removing";

export interface WorktreeBase {
  /** The branch the repo's checkout was on, absent when HEAD was detached. */
  ref?: string;
  /** Where that checkout was. */
  sha: string;
}

export interface WorktreeRecord {
  id: string;
  repoRoot: string;
  path: string;
  branch: string;
  base: WorktreeBase;
  roomId: string;
  agentId: string;
  createdAt: number;
  state: WorktreeState;
  /** Someone said the branch's work was integrated (a squash or rebase
   * merge leaves no ancestor to find). */
  declaredIntegrated?: { by: "agent" | "user"; at: number; /** The branch tip it was said of: later commits are not covered. */ tip?: string };
  /** The common git dir, where git still answers if the checkout named is gone. */
  commonDir?: string;
  retained?: { reason: string; at: number };
  /** Set with `state: "removing"`: what was decided, so a crash half way
   * is finished rather than reconsidered. */
  removing?: { force: boolean; reason: string; /** The branch tip the decision was made of: a removal resumed after a crash is for that tip only. */ tip?: string };
}

/** A name safe as a branch segment and a directory: lowercase letters,
 * digits and hyphens, at most `max` characters. */
export function slugify(text: string, max = 30): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug || "agent";
}

/** `<slug>-<4 hex>`: the directory name, and the branch below the prefix. */
export function worktreeName(title: string, hex: string): string {
  return `${slugify(title)}-${hex}`;
}

export function branchFor(name: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${name}`;
}

export function pathFor(worktreesRoot: string, repoRoot: string, name: string): string {
  const repoName = slugify(repoRoot.split(sep).filter(Boolean).pop() ?? "repo", 40);
  return join(worktreesRoot, repoName, name);
}

/** Whether `path` is inside `root` (not `root` itself). */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

/** A record the relay may act on: its path is under the worktrees folder and
 * its branch carries the prefix. A record failing this was edited by hand or
 * is not ours; it is dropped untouched, never cleaned up. */
export function isOurs(record: Pick<WorktreeRecord, "path" | "branch">, worktreesRoot: string): boolean {
  return isInside(worktreesRoot, record.path) && record.branch.startsWith(WORKTREE_BRANCH_PREFIX) && record.branch.length > WORKTREE_BRANCH_PREFIX.length && !record.branch.includes("..");
}

export interface CleanupFacts {
  /** The agent has a turn running: its worktree is in use. */
  agentBusy: boolean;
  /** Automatic cleanup only takes worktrees of agents that are done. */
  agentDone: boolean;
  /** Asked for by the person ("discard anyway"): the one case that forces. */
  discard: boolean;
  /** The branch's tip is an ancestor of its base. */
  ancestor: boolean;
  /** Someone said so, of the tip the branch has now. */
  declaredIntegrated: boolean;
  /** The worktree's HEAD holds commits no branch of ours has (detached, or on another branch). */
  strayCommits: boolean;
  /** The branch's work, at the tip it has now, is on its base as a squash or
   * rebase merge: the base's tip holds all of it (false when unknown). */
  squashed: boolean;
  /** A pull request into its base was merged with the branch's tip as its
   * head (best effort; false when unknown). */
  prMerged: boolean;
  worktreeExists: boolean;
  /** No uncommitted or untracked changes (true when there is no worktree). */
  clean: boolean;
  /** A submodule is initialized in it: git refuses to remove it without force. */
  hasSubmodules: boolean;
}

export type CleanupDecision =
  | { action: "skip"; reason: string }
  | { action: "retain"; reason: string }
  | { action: "remove"; evidence: "ancestor" | "declared" | "squash" | "pull_request" | "discard"; force: boolean };

export function decideCleanup(facts: CleanupFacts, auto: boolean): CleanupDecision {
  if (facts.agentBusy) return { action: "skip", reason: "the agent has a turn running" };
  if (auto && !facts.agentDone) return { action: "skip", reason: "the agent is not done" };
  if (facts.discard) return { action: "remove", evidence: "discard", force: true };
  if (facts.strayCommits) return { action: "retain", reason: "its worktree holds commits that are on no branch of its own" };
  const evidence = facts.ancestor ? "ancestor" : facts.declaredIntegrated ? "declared" : facts.squashed ? "squash" : facts.prMerged ? "pull_request" : undefined;
  if (!evidence) return { action: "retain", reason: "its branch is not merged into its base, and nobody said it was integrated" };
  if (!facts.clean) return { action: "retain", reason: "its worktree has uncommitted changes or files git ignores" };
  if (facts.hasSubmodules) return { action: "retain", reason: "a submodule is initialized in it; removing it needs an explicit discard" };
  return { action: "remove", evidence, force: false };
}
