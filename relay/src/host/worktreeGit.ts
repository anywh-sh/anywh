// The git behind agents' worktrees: real `git` calls, each answering with
// what git said rather than throwing, so the caller decides what a refusal
// means (a retained worktree, a rollback). Nothing here decides policy.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { WorktreeBase } from "./worktreePolicy.js";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | string | null;
}

const GIT_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"];

/** Env for git: the machine's own, minus variables that would make it answer
 * for another repository, never prompting, in English so refusals can be told apart. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const name of GIT_LOCATION_VARS) delete env[name];
  return env;
}

export function runGit(cwd: string, args: readonly string[], timeoutMs = 120_000): Promise<GitResult> {
  return new Promise((resolveRun) => {
    execFile("git", args, { cwd, env: gitEnv(), timeout: timeoutMs, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number | string }).code ?? null) : 0;
      resolveRun({ ok: !error, stdout, stderr, code });
    });
  });
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export interface RepoFacts {
  /** The work tree's top level (real path). */
  root: string;
  /** The folder asked for, relative to `root` ("" when it is the root). */
  subpath: string;
  /** The common git dir (real path): the same for every worktree of the repo. */
  commonDir: string;
  base: WorktreeBase;
}

/** What a path says about the repository it is in: `undefined` for a path that
 * is not inside a non-bare work tree with at least one commit. */
export async function readRepo(path: string): Promise<RepoFacts | { error: string }> {
  if (!existsSync(path)) return { error: `${path} does not exist` };
  const top = await runGit(path, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { error: `${path} is not inside a git work tree` };
  const root = real(top.stdout.trim());
  const common = await runGit(root, ["rev-parse", "--git-common-dir"]);
  const sha = await runGit(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!common.ok || !sha.ok) return { error: `${root} has no commit to start a worktree from` };
  const ref = await runGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const ownRef = ref.ok && ref.stdout.trim() !== "" ? ref.stdout.trim() : undefined;
  return {
    root,
    subpath: relative(root, real(path)),
    commonDir: real(resolve(root, common.stdout.trim())),
    base: { ...(ownRef ? { ref: ownRef } : {}), sha: sha.stdout.trim() },
  };
}

/** Whether the branch exists. A git that failed to answer (a timeout, a
 * broken repository) is not "no": only its exit status 1 is. */
export function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  return runGit(repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).then((r) => r.ok || r.code !== 1);
}

export async function branchTip(repoRoot: string, branch: string): Promise<string | undefined> {
  const r = await runGit(repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
  return r.ok ? r.stdout.trim() : undefined;
}

export interface ListedWorktree {
  path: string;
  branch?: string;
  prunable: boolean;
}

export async function listWorktrees(repoRoot: string): Promise<ListedWorktree[]> {
  const r = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  const out: ListedWorktree[] = [];
  for (const block of r.stdout.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const branch = lines.find((l) => l.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
    out.push({ path: real(path), ...(branch ? { branch } : {}), prunable: lines.some((l) => l.startsWith("prunable")) });
  }
  return out;
}

export function addWorktree(repoRoot: string, path: string, branch: string, startPoint: string): Promise<GitResult> {
  return runGit(repoRoot, ["worktree", "add", "-b", branch, path, startPoint]);
}

/** `git submodule update --init` in a fresh worktree, when it has any. */
export async function initSubmodules(path: string): Promise<GitResult | undefined> {
  if (!existsSync(join(path, ".gitmodules"))) return undefined;
  return runGit(path, ["submodule", "update", "--init", "--recursive"], 300_000);
}

/** Whether a submodule is initialized in the worktree (git then refuses to remove it). */
export async function hasInitializedSubmodules(path: string): Promise<boolean> {
  if (!existsSync(join(path, ".gitmodules"))) return false;
  const r = await runGit(path, ["submodule", "status"]);
  return r.ok && r.stdout.split("\n").some((line) => line.trim() !== "" && !line.startsWith("-"));
}

/** Ignored folders a build recreates: removing them loses nothing. */
const REBUILDABLE = /^(node_modules|dist|build|target|coverage|__pycache__|\.next|\.cache|\.venv)\/?$|(^|\/)node_modules\/?$/;

/** No uncommitted or untracked changes, and no ignored file that is not a
 * rebuildable folder (a `.env` is not in git and `worktree remove` deletes it). */
export async function isClean(path: string): Promise<boolean> {
  // Without its own `.git` git would answer for a repository around it.
  if (!existsSync(join(path, ".git"))) return false;
  const r = await runGit(path, ["status", "--porcelain", "--untracked-files=normal", "--ignored=traditional"]);
  if (!r.ok) return false;
  return r.stdout.split("\n").every((line) => line.trim() === "" || (line.startsWith("!! ") && REBUILDABLE.test(line.slice(3))));
}

/** What a worktree's own HEAD is on: a branch, or a bare commit. */
export async function worktreeHead(path: string): Promise<{ branch?: string; sha: string } | undefined> {
  if (!existsSync(join(path, ".git"))) return undefined;
  const sha = await runGit(path, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!sha.ok) return undefined;
  const ref = await runGit(path, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = ref.ok && ref.stdout.trim() !== "" ? ref.stdout.trim() : undefined;
  return { ...(branch ? { branch } : {}), sha: sha.stdout.trim() };
}

/** Whether a commit is an ancestor of the base. */
export async function isCommitInBase(repoRoot: string, sha: string, base: WorktreeBase): Promise<boolean> {
  const target = base.ref && (await branchExists(repoRoot, base.ref)) ? `refs/heads/${base.ref}` : base.sha;
  return (await runGit(repoRoot, ["merge-base", "--is-ancestor", sha, target])).ok;
}

/** Whether `branch`'s tip is an ancestor of `base` (its ref while that still
 * exists, else the sha it started from). */
export async function isAncestorOfBase(repoRoot: string, branch: string, base: WorktreeBase): Promise<boolean> {
  const target = base.ref && (await branchExists(repoRoot, base.ref)) ? `refs/heads/${base.ref}` : base.sha;
  return (await runGit(repoRoot, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, target])).ok;
}

export async function commitsAhead(repoRoot: string, branch: string, base: WorktreeBase): Promise<number | undefined> {
  const target = base.ref && (await branchExists(repoRoot, base.ref)) ? `refs/heads/${base.ref}` : base.sha;
  const r = await runGit(repoRoot, ["rev-list", "--count", `${target}..refs/heads/${branch}`]);
  return r.ok ? Number(r.stdout.trim()) : undefined;
}

export function removeWorktree(repoRoot: string, path: string, force: boolean): Promise<GitResult> {
  return runGit(repoRoot, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
}

export function deleteBranch(repoRoot: string, branch: string): Promise<GitResult> {
  return runGit(repoRoot, ["branch", "-D", branch]);
}

/**
 * Forgets one worktree whose directory is gone, and only that one: `git
 * worktree prune` would also drop the user's own stale entries, so the
 * entry's admin folder is found by the path it records and removed alone.
 */
export function forgetMissingWorktree(commonDir: string, path: string): boolean {
  const base = join(commonDir, "worktrees");
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return false;
  }
  for (const entry of entries) {
    try {
      const recorded = readFileSync(join(base, entry, "gitdir"), "utf8").trim();
      if (resolve(dirname(recorded)) === resolve(path)) {
        rmSync(join(base, entry), { recursive: true, force: true });
        return true;
      }
    } catch {
      // not an entry we can read: not ours to judge
    }
  }
  return false;
}

/** Whether the branch's pull request was merged *at this tip*, by `gh` when
 * it is installed and the repo has a remote: commits pushed after the merge
 * are not covered by it. Anything else (no `gh`, no network, no such PR) is `false`. */
export function pullRequestMerged(repoRoot: string, branch: string, tip: string | undefined, gh = "gh"): Promise<boolean> {
  if (!tip) return Promise.resolve(false);
  return new Promise((resolveRun) => {
    execFile(gh, ["pr", "view", branch, "--json", "state,headRefOid", "--jq", '.state + " " + .headRefOid'], { cwd: repoRoot, env: gitEnv(), timeout: 15_000, encoding: "utf8" }, (error, stdout) => {
      resolveRun(!error && stdout.trim() === `MERGED ${tip}`);
    });
  });
}

/** Disk the directory takes, `du`-style, in bytes; `undefined` when it cannot be told. */
export function directorySize(path: string): Promise<number | undefined> {
  return new Promise((resolveRun) => {
    execFile("du", ["-sk", path], { encoding: "utf8", timeout: 60_000 }, (error, stdout) => {
      const kb = Number.parseInt(stdout.split("\t")[0] ?? "", 10);
      resolveRun(error || !Number.isFinite(kb) ? undefined : kb * 1024);
    });
  });
}
