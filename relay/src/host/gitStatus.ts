import { execFile } from "node:child_process";

// Backs `GET /git/status`: the branch and change count the client's status
// bar renders for whichever session it is showing. The cwd is always the
// session's own (`sessionStore.getCwdState`), never a path the client sends
// — same rule as the `/files/*` routes.
//
// One `git` call per request, and never from a timer: the client asks when
// the focused session changes, when a turn ends and when the window regains
// focus (see client/src/components/shell/StatusBar.tsx). Every failure mode
// — no git installed, not a repository, a repo so large the call times out —
// collapses into `{ repo: false }`, which hides the segment instead of
// putting an error in the one strip of the window that is never dismissable.

export type GitStatus = { repo: false } | { repo: true; branch: string; detached: boolean; changes: number };

/** How long `git status` may take before the status bar gives up on it. A
 * cold cache on a very large repository is the realistic slow case; past
 * this, a stale-looking empty segment beats a request left hanging. */
const TIMEOUT_MS = 2_000;

/** `git status` writes this in place of a branch name when HEAD isn't on
 * one — a literal, not a branch that could ever exist (a ref name can't
 * contain parentheses). */
const DETACHED = "(detached)";

/**
 * Turns `git status --porcelain=v2 --branch` output into what the status bar
 * shows. Kept separate from the spawn so the format — the part that actually
 * has edge cases — is testable without a repository on disk.
 *
 * `changes` counts entries, not lines: one per changed tracked file (`1`),
 * per rename/copy (`2`, whose original path follows a tab on the same line),
 * per unmerged path (`u`) and per untracked file (`?`). That is deliberately
 * the same set `git status` itself would list, ignored files excluded.
 */
export function parseGitStatus(stdout: string): { branch: string; detached: boolean; changes: number } {
  let head = "";
  let oid = "";
  let changes = 0;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      head = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.oid ")) {
      oid = line.slice("# branch.oid ".length).trim();
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ") || line.startsWith("? ")) {
      changes += 1;
    }
  }

  const detached = head === DETACHED;
  // A repository whose first commit doesn't exist yet reports `(initial)`
  // here, which is no more a commit to show than `(detached)` is a branch.
  const shortOid = oid.startsWith("(") ? "" : oid.slice(0, 7);
  return { branch: detached ? shortOid : head, detached, changes };
}

function runGit(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      // `--no-optional-locks` is what keeps this from ever taking
      // `index.lock`: the agent runs its own git commands in this same
      // directory, and a status poll must not be able to lose a race with
      // one of them.
      ["--no-optional-locks", "status", "--porcelain=v2", "--branch"],
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/** Never rejects: the caller is a strip of chrome with nowhere to put an
 * error, so "couldn't tell" and "not a repository" are the same answer. */
export async function readGitStatus(cwd: string): Promise<GitStatus> {
  try {
    const parsed = parseGitStatus(await runGit(cwd));
    if (!parsed.branch) return { repo: false };
    return { repo: true, ...parsed };
  } catch {
    return { repo: false };
  }
}
