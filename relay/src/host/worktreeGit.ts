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

/** What the base names now: its branch while that still exists, else the
 * sha it started from. */
async function baseTarget(repoRoot: string, base: WorktreeBase): Promise<string> {
  return base.ref && (await branchExists(repoRoot, base.ref)) ? `refs/heads/${base.ref}` : base.sha;
}

/** Whether a commit is an ancestor of the base. */
export async function isCommitInBase(repoRoot: string, sha: string, base: WorktreeBase): Promise<boolean> {
  const target = await baseTarget(repoRoot, base);
  return (await runGit(repoRoot, ["merge-base", "--is-ancestor", sha, target])).ok;
}

/** Whether `branch`'s tip is an ancestor of `base` (its ref while that still
 * exists, else the sha it started from). */
export async function isAncestorOfBase(repoRoot: string, branch: string, base: WorktreeBase): Promise<boolean> {
  const target = await baseTarget(repoRoot, base);
  return (await runGit(repoRoot, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, target])).ok;
}

export async function commitsAhead(repoRoot: string, branch: string, base: WorktreeBase): Promise<number | undefined> {
  const target = await baseTarget(repoRoot, base);
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

/** The sha the base resolves to now, `undefined` when git cannot say. */
export async function baseTip(repoRoot: string, base: WorktreeBase): Promise<string | undefined> {
  const r = await runGit(repoRoot, ["rev-parse", "--verify", "-q", `${await baseTarget(repoRoot, base)}^{commit}`]);
  return r.ok ? r.stdout.trim() : undefined;
}

let warnedMergeTree = false;
function warnMergeTreeUnsupported(): void {
  if (warnedMergeTree) return;
  warnedMergeTree = true;
  console.warn("[relay] git is older than 2.40 (no `merge-tree --write-tree --merge-base`): squash and rebase merges of agent worktrees cannot be recognised, so those worktrees are kept");
}

/**
 * Whether the work between the branch's fork point and `tip` is on the base
 * now, however it got there: a squash merge, a rebase merge, a cherry-pick.
 * Asked as "would merging `tip` into the base's current tip change nothing?"
 * (`git merge-tree`, three-way from the fork point, written to no ref): a
 * clean merge whose tree is the base's own means every change the branch
 * made, byte for byte, with its file modes, binaries included, is in the
 * base as it is today. A change made after the merge (whitespace only, a
 * mode bit), a squash edited at merge time, or one reverted on the base
 * since, all leave something to merge, or a conflict, and so no proof. An
 * empty diff proves nothing. Needs git 2.40 (`--merge-base`): an older git
 * refuses the options, which is no proof either (said once in the log, since
 * from then on no squash is ever found). Any failure or doubt is `false`: a
 * missed squash only keeps a worktree, a wrong one would lose work.
 *
 * `baseSha` is the base's tip the caller already resolved: the answer is
 * then about exactly that commit, even if the base moves meanwhile.
 */
export async function squashedIntoBase(repoRoot: string, tip: string, base: WorktreeBase, baseSha?: string): Promise<boolean> {
  const target = baseSha ?? (await baseTarget(repoRoot, base));
  const forkPoint = await runGit(repoRoot, ["merge-base", tip, target], 30_000);
  if (!forkPoint.ok) return false;
  const fork = forkPoint.stdout.trim();
  // A tip that is the fork point is an ancestor of the base, not a squash.
  if (fork === "" || fork === tip) return false;
  // No change at all (the branch's commits cancel out) is no evidence of
  // anything. Exit status 1 is "they differ"; anything but 0 or 1 is a failure.
  const changed = await runGit(repoRoot, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", fork, tip], 30_000);
  if (changed.code !== 1) return false;
  const baseTree = await runGit(repoRoot, ["rev-parse", "--verify", "-q", `${target}^{tree}`]);
  if (!baseTree.ok) return false;
  // Renormalization would let a line-ending change merge into nothing.
  const merged = await runGit(repoRoot, ["-c", "merge.renormalize=false", "merge-tree", "--write-tree", "--no-messages", `--merge-base=${fork}`, target, tip], 60_000);
  // Exit status 1 is a conflict: the branch and the base disagree somewhere.
  // 129 is git refusing the options: too old for `--write-tree --merge-base`.
  if (merged.code === 129) warnMergeTreeUnsupported();
  if (!merged.ok) return false;
  const tree = merged.stdout.split("\n")[0]?.trim() ?? "";
  return /^[0-9a-f]{40,64}$/.test(tree) && tree === baseTree.stdout.trim();
}

interface PullRequestSummary {
  merged_at?: unknown;
  base?: { ref?: unknown };
  head?: { sha?: unknown };
}

/** `gh api <endpoint>`, parsed: `undefined` when gh failed (missing, no
 * remote, no login, no network, an HTTP error) or answered something else
 * than JSON. `{owner}/{repo}` are filled in by gh from the repo's remote. */
function ghApi(repoRoot: string, gh: string, endpoint: string): Promise<unknown> {
  return new Promise((resolveRun) => {
    const args = ["api", "-H", "Accept: application/vnd.github+json", endpoint];
    execFile(gh, args, { cwd: repoRoot, env: { ...gitEnv(), GH_PROMPT_DISABLED: "1" }, timeout: 15_000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return resolveRun(undefined);
      try {
        resolveRun(JSON.parse(stdout) as unknown);
      } catch {
        resolveRun(undefined);
      }
    });
  });
}

/** Pages of a commit's pull requests read before giving up on the list. */
const PULL_PAGES = 5;
/** Pull requests the search fallback checks one by one. */
const SEARCHED_PULLS = 10;
/** Most time one question about a tip may spend on GitHub, in all its calls:
 * cleanups run one at a time, so a slow gh must not hold up the rest. */
const PULL_BUDGET_MS = 30_000;

/**
 * Whether a pull request was merged with `tip` as its head, asked of GitHub
 * by commit, so one opened from another branch at the same commit counts
 * too. Only a merged one whose head is exactly `tip`: one whose head went on
 * past `tip` says nothing about this one. When the worktree started on a
 * branch, the pull request must have gone into it; one started from a
 * detached HEAD has no branch to compare, and a pull request merged anywhere
 * at this exact tip is taken, as `gh pr view <branch>` used to.
 *
 * First `commits/<tip>/pulls`, a page at a time. GitHub documents it as
 * listing only open pull requests for a commit that is not on the default
 * branch, which a squash-merged head never is (it does list merged ones in
 * practice, at least into the default branch): when it shows none that
 * proves the tip, a search for merged pull requests mentioning the commit
 * is asked, and each one found is read for its head and base, all within
 * `PULL_BUDGET_MS`; out of time is no proof. Anything else
 * (no `gh`, no remote, no login, no network, a commit GitHub does not know)
 * is `false`.
 */
export async function pullRequestMerged(repoRoot: string, tip: string | undefined, base: WorktreeBase, gh = "gh"): Promise<boolean> {
  if (!tip || !/^[0-9a-f]{40,64}$/.test(tip)) return false;
  const proves = (entry: unknown): boolean => {
    if (typeof entry !== "object" || entry === null) return false;
    const pr = entry as PullRequestSummary;
    return typeof pr.merged_at === "string" && pr.merged_at !== "" && (base.ref === undefined || pr.base?.ref === base.ref) && pr.head?.sha === tip;
  };
  const deadline = Date.now() + PULL_BUDGET_MS;
  for (let page = 1; page <= PULL_PAGES; page++) {
    if (Date.now() > deadline) return false;
    const pulls = await ghApi(repoRoot, gh, `repos/{owner}/{repo}/commits/${tip}/pulls?per_page=100&page=${page}`);
    // A gh that cannot answer at all is not asked again, by search or otherwise.
    if (!Array.isArray(pulls)) return false;
    if (pulls.some(proves)) return true;
    if (pulls.length < 100) break;
  }
  if (Date.now() > deadline) return false;
  const found = await ghApi(repoRoot, gh, `search/issues?q=repo:{owner}/{repo}+is:pr+is:merged+${tip}&per_page=${SEARCHED_PULLS}`);
  const items = typeof found === "object" && found !== null && Array.isArray((found as { items?: unknown }).items) ? (found as { items: unknown[] }).items : [];
  for (const item of items.slice(0, SEARCHED_PULLS)) {
    const number = typeof item === "object" && item !== null ? (item as { number?: unknown }).number : undefined;
    if (typeof number !== "number" || !Number.isInteger(number)) continue;
    if (Date.now() > deadline) return false;
    if (proves(await ghApi(repoRoot, gh, `repos/{owner}/{repo}/pulls/${number}`))) return true;
  }
  return false;
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
