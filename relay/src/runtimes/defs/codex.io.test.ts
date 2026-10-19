import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRuntimeDef } from "./codex.js";

function writableRootsFor(cwd: string): readonly string[] {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const spec = codexRuntimeDef.exec.turn.start({ cwd, prompt: "hi", permissionModeId: "workspace-write" }, "t1");
  const policy = (spec.params as { sandboxPolicy: { writableRoots: string[] } }).sandboxPolicy;
  return policy.writableRoots;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
}

function withTmp(fn: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-roots-")));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("workspace-write: a plain repo adds its own .git to the writable roots", () => {
  withTmp((dir) => {
    git(dir, "init", "-q");
    assert.deepEqual(writableRootsFor(dir), [dir, join(dir, ".git")]);
  });
});

test("workspace-write: a subdirectory of a repo still resolves the repo's .git", () => {
  withTmp((dir) => {
    git(dir, "init", "-q");
    const sub = join(dir, "pkg");
    mkdirSync(sub);
    assert.deepEqual(writableRootsFor(sub), [sub, join(dir, ".git")]);
  });
});

test("workspace-write: a git worktree adds both its gitdir and the common dir", () => {
  withTmp((dir) => {
    const main = join(dir, "main");
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const wt = join(dir, "wt");
    git(main, "worktree", "add", "-q", "-b", "feature", wt);
    assert.deepEqual(writableRootsFor(wt), [wt, join(main, ".git", "worktrees", "wt"), join(main, ".git")]);
  });
});

test("workspace-write: outside a git repo the roots stay just the cwd", () => {
  withTmp((dir) => {
    assert.deepEqual(writableRootsFor(dir), [dir]);
  });
});
