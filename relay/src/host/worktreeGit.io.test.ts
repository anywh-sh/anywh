import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isClean } from "./worktreeGit.js";

// The relay checks a room's worktrees while an agent (or the person) may be
// committing in them. A plain `git status` takes `index.lock` to write back
// refreshed stat info, and a `git commit` landing in that window fails with
// "index.lock: File exists" — seen in CI as a flaky room e2e. The relay's
// reads must leave the index alone.
test("isClean never rewrites the worktree's index, so it can't hold index.lock against a commit", async () => {
  const repo = mkdtempSync(join(tmpdir(), "anywh-worktree-git-test-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@anywh.test", "-c", "user.name=t", ...args], { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    writeFileSync(join(repo, "file.txt"), "same content\n");
    git("add", "file.txt");
    git("commit", "-q", "-m", "init");

    // Same content, new stat info: exactly what a status refreshes and
    // writes back to the index. The index is dated in the past so a rewrite
    // shows up as a new mtime.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repo, "file.txt"), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    utimesSync(join(repo, ".git", "index"), past, past);
    const before = statSync(join(repo, ".git", "index")).mtimeMs;

    assert.equal(await isClean(repo), true);

    assert.equal(statSync(join(repo, ".git", "index")).mtimeMs, before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
