// The git behind agents' worktrees: real `git` calls, each answering with
// what git said rather than throwing, so the caller decides what a refusal
// means (a retained worktree, a rollback). Nothing here decides policy.
import { execFile, spawn } from "node:child_process";
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

/** Flags every diff fed to `git patch-id` carries, so both sides of a
 * comparison are the same kind of patch: binary content included (or two
 * different binaries would compare equal), no renames, no external tools. */
const PATCH_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary"];

/** `git <args> | git patch-id --stable`, streamed: the `<patch-id> <commit>`
 * pairs, or `undefined` when either side failed or ran out of time. */
function patchIds(cwd: string, args: readonly string[], timeoutMs = 60_000): Promise<Array<{ id: string; commit: string }> | undefined> {
  return new Promise((resolveRun) => {
    const env = gitEnv();
    const producer = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const consumer = spawn("git", ["patch-id", "--stable"], { cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let out = "";
    let pending = 2;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      producer.kill("SIGKILL");
      consumer.kill("SIGKILL");
    }, timeoutMs);
    const settle = (code: number | null): void => {
      if (code !== 0) failed = true;
      if (--pending > 0) return;
      clearTimeout(timer);
      if (failed) return resolveRun(undefined);
      const pairs = out
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((parts): parts is [string, string] => parts.length === 2 && /^[0-9a-f]{40,64}$/.test(parts[0] ?? ""))
        .map(([id, commit]) => ({ id, commit }));
      resolveRun(pairs);
    };
    // `close` follows `error` when a spawn fails: each process settles once.
    producer.once("close", settle);
    consumer.once("close", settle);
    producer.on("error", () => (failed = true));
    consumer.on("error", () => (failed = true));
    consumer.stdin.on("error", () => (failed = true));
    producer.stdout.pipe(consumer.stdin);
    consumer.stdout.setEncoding("utf8");
    consumer.stdout.on("data", (chunk: string) => (out += chunk));
  });
}

/** How far back on the base a squash or rebase of the branch is looked for. */
const SQUASH_SEARCH_LIMIT = 500;

/**
 * Whether the work between the branch's fork point and `tip` is on the base
 * as a squash merge (one first-parent commit of the base whose patch is the
 * branch's whole diff) or a rebase merge (every commit of the branch has an
 * equivalent on the base). Compared by `git patch-id`, which ignores line
 * numbers and whitespace but not content: a branch that holds anything the
 * base does not, a commit made after the merge included, has a different
 * patch. An empty diff proves nothing. Any failure or doubt is `false`: a
 * missed squash only keeps a worktree, a wrong one would lose work.
 */
export async function squashedIntoBase(repoRoot: string, tip: string, base: WorktreeBase): Promise<boolean> {
  const target = await baseTarget(repoRoot, base);
  const forkPoint = await runGit(repoRoot, ["merge-base", tip, target], 30_000);
  if (!forkPoint.ok) return false;
  const fork = forkPoint.stdout.trim();
  // A tip that is the fork point is an ancestor of the base, not a squash.
  if (fork === "" || fork === tip) return false;
  const own = await patchIds(repoRoot, ["diff", ...PATCH_FLAGS, fork, tip]);
  // No patch at all (the branch's commits cancel out) is no evidence of anything.
  const ownId = own?.length === 1 ? own[0]?.id : undefined;
  if (!ownId) return false;

  const onBase = await patchIds(repoRoot, ["log", "--first-parent", "-p", ...PATCH_FLAGS, `--max-count=${SQUASH_SEARCH_LIMIT}`, "--format=commit %H", `${fork}..${target}`]);
  if (onBase?.some((pair) => pair.id === ownId)) return true;

  // A rebase merge: each commit of the branch replayed on the base. A merge
  // commit on the branch has no patch of its own to compare (it may hold a
  // conflict resolution), so a branch with one is not judged this way.
  const merges = await runGit(repoRoot, ["rev-list", "--count", "--merges", `${fork}..${tip}`], 30_000);
  if (!merges.ok || merges.stdout.trim() !== "0") return false;
  const baseSize = await runGit(repoRoot, ["rev-list", "--count", `${fork}..${target}`], 30_000);
  if (!baseSize.ok || !(Number(baseSize.stdout.trim()) <= SQUASH_SEARCH_LIMIT)) return false;
  const marked = await runGit(repoRoot, ["rev-list", "--cherry-mark", "--right-only", "--no-merges", `${target}...${tip}`], 60_000);
  if (!marked.ok) return false;
  const lines = marked.stdout.split("\n").filter((line) => line.trim() !== "");
  return lines.length > 0 && lines.every((line) => line.startsWith("="));
}

interface PullRequestSummary {
  merged_at?: unknown;
  base?: { ref?: unknown };
  head?: { sha?: unknown };
}

/**
 * Whether a pull request into the worktree's base branch was merged with
 * `tip` as its head, asked of GitHub by commit (`gh api .../commits/<tip>/pulls`),
 * so one opened from another branch at the same commit counts too. Only a
 * merged one whose head is exactly `tip` and whose base is the branch the
 * worktree started from: one whose head went on past `tip`, or that went
 * into another branch, says nothing about this one. Anything else (no `gh`,
 * no remote, no login, no network, a commit GitHub does not know) is `false`.
 */
export function pullRequestMerged(repoRoot: string, tip: string | undefined, base: WorktreeBase, gh = "gh"): Promise<boolean> {
  const baseRef = base.ref;
  if (!tip || !/^[0-9a-f]{40,64}$/.test(tip) || !baseRef) return Promise.resolve(false);
  return new Promise((resolveRun) => {
    const args = ["api", "-H", "Accept: application/vnd.github+json", `repos/{owner}/{repo}/commits/${tip}/pulls?per_page=100`];
    execFile(gh, args, { cwd: repoRoot, env: { ...gitEnv(), GH_PROMPT_DISABLED: "1" }, timeout: 15_000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return resolveRun(false);
      let pulls: unknown;
      try {
        pulls = JSON.parse(stdout);
      } catch {
        return resolveRun(false);
      }
      if (!Array.isArray(pulls)) return resolveRun(false);
      resolveRun(
        pulls.some((entry: unknown) => {
          if (typeof entry !== "object" || entry === null) return false;
          const pr = entry as PullRequestSummary;
          return typeof pr.merged_at === "string" && pr.merged_at !== "" && pr.base?.ref === baseRef && pr.head?.sha === tip;
        }),
      );
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
