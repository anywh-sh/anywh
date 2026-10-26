// The worktree cycle against real git in throwaway repositories: no model, no
// mocks. A worktree is created for an agent, worked in, integrated by the
// ways a person integrates (merge, squash), and removed; and through every
// path, including a crash between any two steps, nothing is left behind and
// nothing that anywh did not create is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { WorktreeRegistry } from "../host/worktreeRegistry.js";
import { RoomWorktrees } from "./roomWorktrees.js";

let dir: string;
let counter = 0;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "anywh-worktrees-"));
  // A local submodule is a `file` transport, which git refuses by default.
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
  process.env.GIT_CONFIG_VALUE_0 = "always";
});
after(() => rmSync(dir, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(name = "app"): string {
  const repo = join(dir, `${name}-${++counter}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

interface Harness {
  repo: string;
  root: string;
  registry: WorktreeRegistry;
  registryFile: string;
  worktrees: RoomWorktrees;
  agent: { exists: boolean; busy: boolean; done: boolean };
}

function harness(repo = makeRepo(), gh = "/nonexistent/gh"): Harness {
  const root = join(dir, `wt-root-${++counter}`);
  const registryFile = join(dir, `registry-${counter}.json`);
  const registry = new WorktreeRegistry(registryFile);
  const agent = { exists: true, busy: false, done: true };
  const worktrees = new RoomWorktrees({ registry, root, gh, agents: { facts: () => ({ ...agent, title: "Fix the cart", cwd: repo, roomId: "room" }) } });
  return { repo, root, registry, registryFile, worktrees, agent };
}

const branches = (repo: string): string[] => git(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
const listed = (repo: string): string[] => git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));

async function created(h: Harness, repoArg = h.repo): Promise<{ path: string; branch: string; workdir: string }> {
  const result = await h.worktrees.create("room", "agent-1", repoArg);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result;
}

function commitIn(path: string, file = "new.txt"): void {
  writeFileSync(join(path, file), "work\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "work");
}

function assertNoTrace(h: Harness): void {
  assert.deepEqual(branches(h.repo), ["main"], "no branch left");
  assert.equal(listed(h.repo).length, 1, "only the repository's own worktree is listed");
  assert.deepEqual(new WorktreeRegistry(h.registryFile).all(), [], "no record left");
  assert.equal(existsSync(h.root) ? readdirDeep(h.root) : 0, 0, "no directory left under the worktrees folder");
}

function readdirDeep(path: string): number {
  const r = spawnSync("find", [path, "-mindepth", "2", "-maxdepth", "2"], { encoding: "utf8" });
  return r.stdout.split("\n").filter(Boolean).length;
}

test("create → work → merge → cleanup leaves no worktree, branch or record", async () => {
  const h = harness();
  const wt = await created(h);
  assert.ok(wt.path.startsWith(h.root), "outside the repository, under the worktrees folder");
  assert.match(wt.branch, /^anywh\/fix-the-cart-[0-9a-f]{4}$/);
  assert.equal(wt.workdir, wt.path);
  assert.equal(h.registry.all()[0]?.state, "created");
  commitIn(wt.path);
  git(h.repo, "merge", "-q", "--no-ff", "-m", "merge", wt.branch);
  const outcome = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.deepEqual(outcome.map((o) => o.result), ["removed"]);
  assertNoTrace(h);
});

test("a worktree nothing was committed in is left alone while its agent exists, and goes with it; one created from a subfolder returns the same subfolder", async () => {
  const h = harness();
  const wt = await created(h, join(h.repo, "src"));
  assert.equal(wt.workdir, join(wt.path, "src"));
  assert.ok(existsSync(join(wt.workdir, "a.txt")));
  const [skipped] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(skipped?.result, "skipped");
  assert.match(skipped?.reason ?? "", /nothing has been committed/);
  assert.ok(existsSync(wt.path), "an agent that has not used it yet keeps it");
  h.agent.exists = false;
  assert.deepEqual((await h.worktrees.sweep()).map((o) => o.result), ["removed"]);
  assertNoTrace(h);
});

test("create → discard leaves no worktree, branch or record", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  const discarded = await h.worktrees.discard(h.registry.all()[0].id);
  assert.equal(discarded?.result, "removed");
  assertNoTrace(h);
});

test("unmerged work is retained with the reason, then discarded only when asked", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "retained");
  assert.match(outcome?.reason ?? "", /not merged/);
  assert.ok(existsSync(wt.path));
  assert.ok(branches(h.repo).includes(wt.branch));
  const info = (await h.worktrees.list("room", { size: true }))[0];
  assert.equal(info.state, "retained");
  assert.equal(info.commitsAhead, 1);
  assert.equal(info.integrated, false);
  assert.ok((info.sizeBytes ?? 0) > 0);
  const discarded = await h.worktrees.discard(info.id);
  assert.equal(discarded?.result, "removed");
  assertNoTrace(h);
});

/** Squash-merges `branch` into the repo's main, after another commit landed
 * there first (so the squash is not the base's only change). */
function squashMerge(repo: string, branch: string): void {
  commitIn(repo, `main-${++counter}.txt`);
  git(repo, "merge", "--squash", branch);
  git(repo, "commit", "-q", "-m", "squashed");
}

test("a squash merge leaves no ancestor, but its patch is on the base: removed without a declaration or gh", async () => {
  const mark = join(dir, `gh-mark-${++counter}`);
  process.env.GH_MARK = mark;
  try {
    const h = harness(makeRepo(), fakeGh());
    const wt = await created(h);
    commitIn(wt.path);
    commitIn(wt.path, "second.txt");
    squashMerge(h.repo, wt.branch);
    const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
    assert.equal(outcome?.result, "removed", outcome?.reason);
    assert.equal(outcome?.reason, "squash");
    assert.equal(existsSync(mark), false, "an offline proof needs no gh");
    assertNoTrace(h);
  } finally {
    delete process.env.GH_MARK;
  }
});

test("a commit made on the branch after its squash merge is not covered by it: retained", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  squashMerge(h.repo, wt.branch);
  commitIn(wt.path, "after-the-merge.txt");
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "retained");
  assert.match(outcome?.reason ?? "", /not merged/);
  assert.ok(existsSync(join(wt.path, "after-the-merge.txt")));
  assert.ok(branches(h.repo).includes(wt.branch));
  assert.equal((await h.worktrees.list("room"))[0]?.integrated, false);
});

test("a change made after a squash merge that only re-indents, flips a mode bit or rewrites a binary is not covered by it: retained", async () => {
  const changes: Array<[string, (path: string) => void]> = [
    // Indentation is content in Python, YAML or a Makefile.
    ["re-indented", (path) => writeFileSync(join(path, "job.py"), "def run():\n\treturn 1\n")],
    ["made executable", (path) => chmodSync(join(path, "job.py"), 0o755)],
    ["binary rewritten", (path) => writeFileSync(join(path, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 9, 9, 9]))],
  ];
  for (const [label, change] of changes) {
    const h = harness();
    const wt = await created(h);
    writeFileSync(join(wt.path, "job.py"), "def run():\n    return 1\n");
    writeFileSync(join(wt.path, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 4, 5, 6]));
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "work");
    squashMerge(h.repo, wt.branch);
    change(wt.path);
    git(wt.path, "commit", "-q", "-am", label);
    const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
    assert.equal(outcome?.result, "retained", label);
    assert.ok(branches(h.repo).includes(wt.branch), label);
    assert.equal((await h.worktrees.list("room"))[0]?.integrated, false, label);
  }
});

test("a squash merge reverted on the base no longer holds the branch's work: retained", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  squashMerge(h.repo, wt.branch);
  git(h.repo, "revert", "--no-edit", "HEAD");
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "retained");
  assert.ok(branches(h.repo).includes(wt.branch));
  assert.equal((await h.worktrees.list("room"))[0]?.integrated, false);
});

test("a squash merge the base went on editing elsewhere in the same file still holds the branch's work: removed", async () => {
  const h = harness();
  writeFileSync(join(h.repo, "src", "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
  git(h.repo, "commit", "-q", "-am", "longer");
  const wt = await created(h);
  writeFileSync(join(wt.path, "src", "a.txt"), "one\n2\n3\n4\n5\n6\n7\n8\n9\n");
  git(wt.path, "commit", "-q", "-am", "work");
  squashMerge(h.repo, wt.branch);
  writeFileSync(join(h.repo, "src", "a.txt"), "one\n2\n3\n4\n5\n6\n7\n8\nnine\n");
  git(h.repo, "commit", "-q", "-am", "later on main");
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "removed", outcome?.reason);
  assert.equal(outcome?.reason, "squash");
  assertNoTrace(h);
});

test("what was proved of a record goes with it, whichever way it leaves the registry", async () => {
  const h = harness();
  const proofs = (): Map<string, unknown> => (h.worktrees as unknown as { proofs: Map<string, unknown> }).proofs;
  // A record that is not ours (outside the worktrees folder), dropped by the sweep.
  const outside = join(dir, `precious-${++counter}`);
  git(h.repo, "worktree", "add", "-q", "-b", "anywh/precious", outside);
  commitIn(outside);
  squashMerge(h.repo, "anywh/precious");
  h.registry.put({ id: "forged", repoRoot: h.repo, path: outside, branch: "anywh/precious", base: { ref: "main", sha: git(h.repo, "rev-parse", "HEAD~2") }, roomId: "room", agentId: "agent-1", createdAt: 1, state: "created" });
  // A creation that never finished and holds nothing anymore, undone by the sweep.
  const wt = await created(h);
  commitIn(wt.path, "ours.txt");
  squashMerge(h.repo, wt.branch);
  assert.deepEqual((await h.worktrees.list("room")).map((info) => info.integrated), [true, true]);
  assert.equal(proofs().size, 2, "list remembered both squash proofs");
  git(h.repo, "worktree", "remove", "--force", wt.path);
  git(h.repo, "branch", "-D", wt.branch);
  h.registry.put({ ...h.registry.all().find((r) => r.branch === wt.branch)!, state: "creating" });
  await h.worktrees.sweep();
  assert.deepEqual(h.registry.all(), []);
  assert.equal(proofs().size, 0);
});

test("a squash with different content (the merge edited the patch) is not the branch's work: retained", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  commitIn(h.repo, `main-${++counter}.txt`);
  git(h.repo, "merge", "--squash", wt.branch);
  writeFileSync(join(h.repo, "new.txt"), "work, edited at merge time\n");
  git(h.repo, "add", "-A");
  git(h.repo, "commit", "-q", "-m", "squashed and edited");
  assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained");
  assert.ok(branches(h.repo).includes(wt.branch));
});

test("a rebase merge replays every commit of the branch on the base: removed; one commit missing, retained", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path, "one.txt");
  commitIn(wt.path, "two.txt");
  commitIn(h.repo, `main-${++counter}.txt`);
  const commits = git(h.repo, "rev-list", "--reverse", `main..${wt.branch}`).split("\n");
  // Only the first replayed: the second commit's work is not on the base.
  git(h.repo, "cherry-pick", commits[0]);
  assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained");
  git(h.repo, "cherry-pick", commits[1]);
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "removed", outcome?.reason);
  assert.equal(outcome?.reason, "squash");
  assertNoTrace(h);
});

test("a branch whose commits cancel out has an empty patch, which proves nothing: retained", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path, "temp.txt");
  git(wt.path, "rm", "-q", "temp.txt");
  git(wt.path, "commit", "-q", "-m", "undo");
  git(h.repo, "commit", "-q", "--allow-empty", "-m", "empty on main");
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "retained");
  assert.ok(branches(h.repo).includes(wt.branch));
});

test("a squash-merged worktree with uncommitted changes is retained, and listed as integrated", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  squashMerge(h.repo, wt.branch);
  writeFileSync(join(wt.path, "scratch.txt"), "uncommitted\n");
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "retained");
  assert.equal(readFileSync(join(wt.path, "scratch.txt"), "utf8"), "uncommitted\n");
  const [info] = await h.worktrees.list("room");
  assert.equal(info?.integrated, true);
  rmSync(join(wt.path, "scratch.txt"));
  const [removed] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(removed?.result, "removed", removed?.reason);
  assertNoTrace(h);
});

test("a declaration still removes what no patch can prove", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained");
  await h.worktrees.declareIntegratedFor("agent-1", "agent");
  assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "removed");
  assertNoTrace(h);
});

test("an integrated branch with uncommitted changes in its worktree is retained, never lost", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  git(h.repo, "merge", "-q", "--no-edit", wt.branch);
  writeFileSync(join(wt.path, "scratch.txt"), "uncommitted\n");
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "retained");
  assert.match(outcome?.reason ?? "", /uncommitted/);
  assert.equal(readFileSync(join(wt.path, "scratch.txt"), "utf8"), "uncommitted\n");
});

test("an agent at work, or one not done, keeps its worktree whatever git says", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  git(h.repo, "merge", "-q", "--no-edit", wt.branch);
  h.agent.busy = true;
  assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: false }))[0]?.result, "skipped");
  h.agent.busy = false;
  h.agent.done = false;
  assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "skipped");
  assert.ok(existsSync(wt.path));
  h.agent.done = true;
  assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "removed");
});

test("the person's own worktrees and branches, even named like ours, are never touched", async () => {
  const h = harness();
  const mine = join(dir, `mine-${++counter}`);
  git(h.repo, "worktree", "add", "-q", "-b", "anywh/user-thing", mine);
  git(h.repo, "branch", "anywh/also-mine");
  git(h.repo, "branch", "feature/x");
  const staleDir = join(dir, `stale-${++counter}`);
  git(h.repo, "worktree", "add", "-q", "-b", "feature/stale", staleDir);
  rmSync(staleDir, { recursive: true });
  const wt = await created(h);
  commitIn(wt.path);
  git(h.repo, "merge", "-q", "--no-edit", wt.branch);
  await h.worktrees.cleanupAgent("agent-1", { auto: true });
  await h.worktrees.sweep();
  assert.deepEqual(branches(h.repo), ["anywh/also-mine", "anywh/user-thing", "feature/stale", "feature/x", "main"]);
  assert.ok(existsSync(mine));
  assert.ok(git(h.repo, "worktree", "list", "--porcelain").includes(staleDir), "the person's stale entry was not pruned");
  assert.deepEqual(h.registry.all(), []);
});

test("a record that points outside the worktrees folder is dropped, its path and branch left alone", async () => {
  const h = harness();
  const outside = join(dir, `precious-${++counter}`);
  git(h.repo, "worktree", "add", "-q", "-b", "anywh/precious", outside);
  h.registry.put({ id: "forged", repoRoot: h.repo, path: outside, branch: "anywh/precious", base: { ref: "main", sha: git(h.repo, "rev-parse", "HEAD") }, roomId: "room", agentId: "agent-1", createdAt: 1, state: "created" });
  await h.worktrees.sweep();
  assert.deepEqual(h.registry.all(), []);
  assert.ok(existsSync(outside));
  assert.ok(branches(h.repo).includes("anywh/precious"));
});

test("a worktree directory deleted by hand: an integrated branch goes, an unintegrated one stays; only our entry is forgotten", async () => {
  const h = harness();
  const a = await created(h);
  commitIn(a.path);
  git(h.repo, "merge", "-q", "--no-edit", a.branch);
  const b = await created(h);
  commitIn(b.path, "b.txt");
  rmSync(a.path, { recursive: true });
  rmSync(b.path, { recursive: true });
  const userStale = join(dir, `ustale-${++counter}`);
  git(h.repo, "worktree", "add", "-q", "-b", "feature/ustale", userStale);
  rmSync(userStale, { recursive: true });
  await h.worktrees.sweep();
  assert.ok(!branches(h.repo).includes(a.branch), "the integrated branch is deleted");
  assert.ok(branches(h.repo).includes(b.branch), "the one with work is kept");
  const list = git(h.repo, "worktree", "list", "--porcelain");
  assert.ok(!list.includes(a.path) && !list.includes(b.path), "our stale entries are forgotten");
  assert.ok(list.includes(userStale), "the person's is not");
  assert.deepEqual(h.registry.all().map((r) => [r.branch, r.state]), [[b.branch, "retained"]]);
});

test("sessions that no longer exist: the sweep removes what is integrated and retains the rest", async () => {
  const h = harness();
  const done = await created(h);
  commitIn(done.path);
  git(h.repo, "merge", "-q", "--no-edit", done.branch);
  const open = await created(h);
  commitIn(open.path, "open.txt");
  h.agent.exists = false;
  const outcomes = await h.worktrees.sweep();
  assert.deepEqual(outcomes.map((o) => o.result).sort(), ["removed", "retained"]);
  assert.ok(!branches(h.repo).includes(done.branch));
  assert.ok(branches(h.repo).includes(open.branch));
  assert.ok(existsSync(open.path));
});

test("a worktree with an initialized submodule is retained when integrated, and a discard removes it", async () => {
  const sub = makeRepo("sub");
  const repo = makeRepo();
  git(repo, "submodule", "add", "-q", sub, "vendor/sub");
  git(repo, "commit", "-q", "-m", "add submodule");
  const h = harness(repo);
  const wt = await created(h);
  assert.ok(existsSync(join(wt.path, "vendor", "sub", "src", "a.txt")), "the submodule was initialized in the worktree");
  commitIn(wt.path);
  git(repo, "merge", "-q", "--no-edit", wt.branch);
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "retained");
  assert.match(outcome?.reason ?? "", /submodule/);
  const discarded = await h.worktrees.discard(h.registry.all()[0].id);
  assert.equal(discarded?.result, "removed");
  assert.ok(!existsSync(wt.path));
  assert.deepEqual(branches(repo), ["main"]);
});

/** A stand-in for `gh api`: `repos/{owner}/{repo}/commits/<sha>/pulls`
 * answers $GH_ANSWER for its first page and $GH_ANSWER_2 (else `[]`) for the
 * second, with the sha asked about for "@tip"; `search/issues` answers
 * $GH_SEARCH (else no result) and `repos/{owner}/{repo}/pulls/<n>` $GH_PULL.
 * Waits $GH_SLEEP seconds and appends its arguments to $GH_MARK first. Fails
 * as gh does for anything else, and for everything with $GH_FAIL. */
function fakeGh(): string {
  const path = join(dir, `gh-${++counter}.sh`);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      '[ -n "$GH_MARK" ] && echo "$*" >> "$GH_MARK"',
      'sleep "${GH_SLEEP:-0}"',
      '[ "$1" = api ] || exit 1',
      '[ -n "$GH_FAIL" ] && { echo "HTTP 422" >&2; exit 1; }',
      'case "$4" in',
      '  "repos/{owner}/{repo}/commits/"*/pulls*)',
      '    tip=$(printf "%s" "$4" | sed -n "s#^repos/{owner}/{repo}/commits/\\([0-9a-f]*\\)/pulls.*#\\1#p")',
      '    page=$(printf "%s" "$4" | sed -n "s#.*[?&]page=\\([0-9]*\\).*#\\1#p")',
      '    case "${page:-1}" in 1) answer="$GH_ANSWER" ;; 2) answer="${GH_ANSWER_2:-[]}" ;; *) answer="[]" ;; esac',
      '    printf "%s\\n" "$answer" | sed "s/@tip/$tip/g" ;;',
      '  search/issues*)',
      '    if [ -n "$GH_SEARCH" ]; then printf "%s\\n" "$GH_SEARCH"; else echo \'{"total_count":0,"items":[]}\'; fi ;;',
      '  "repos/{owner}/{repo}/pulls/"*)',
      '    [ -n "$GH_PULL" ] || { echo "HTTP 404" >&2; exit 1; }',
      '    printf "%s\\n" "$GH_PULL" ;;',
      '  *) exit 1 ;;',
      'esac',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

/** What GitHub answers for a commit's pull requests: one, with these fields. */
function pulls(pr: { merged?: boolean; base?: string; head?: string }): string {
  return JSON.stringify([{ number: 184, state: "closed", merged_at: pr.merged === false ? null : "2026-10-20T12:00:00Z", base: { ref: pr.base ?? "main" }, head: { ref: "feat/another-branch", sha: pr.head ?? "@tip" } }]);
}

test("a pull request merged from another branch at the same tip is found by commit, and proves the work integrated", async () => {
  const mark = join(dir, `gh-mark-${++counter}`);
  const h = harness(makeRepo(), fakeGh());
  const wt = await created(h);
  commitIn(wt.path);
  const tip = git(h.repo, "rev-parse", wt.branch);
  process.env.GH_MARK = mark;
  process.env.GH_ANSWER = pulls({});
  try {
    const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
    assert.equal(outcome?.result, "removed", outcome?.reason);
    assert.equal(outcome?.reason, "pull_request");
    assert.match(readFileSync(mark, "utf8"), new RegExp(`^api .*repos/\\{owner\\}/\\{repo\\}/commits/${tip}/pulls`, "m"));
  } finally {
    delete process.env.GH_MARK;
    delete process.env.GH_ANSWER;
  }
  assertNoTrace(h);
});

test("a pull request whose head went past the tip, into another base, or not merged, proves nothing; nor does gh failing", async () => {
  const h = harness(makeRepo(), fakeGh());
  const wt = await created(h);
  commitIn(wt.path);
  const later = git(h.repo, "rev-parse", "main");
  const retained = async (answer: string, fail = false): Promise<void> => {
    process.env.GH_ANSWER = answer;
    if (fail) process.env.GH_FAIL = "1";
    try {
      const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
      assert.equal(outcome?.result, "retained", answer);
    } finally {
      delete process.env.GH_ANSWER;
      delete process.env.GH_FAIL;
    }
  };
  // The PR's head carries commits made after this tip (it contains the tip, but is not it).
  await retained(pulls({ head: later }));
  await retained(pulls({ base: "release" }));
  await retained(pulls({ merged: false }));
  await retained("[]");
  await retained("not json");
  await retained(pulls({}), true);
  assert.ok(existsSync(wt.path));
  assert.ok(branches(h.repo).includes(wt.branch));
  assert.equal((await h.worktrees.list("room"))[0]?.integrated, false);
});

test("a commit whose pull requests fill a page is read on to the next page", async () => {
  const mark = join(dir, `gh-mark-${++counter}`);
  const h = harness(makeRepo(), fakeGh());
  const wt = await created(h);
  commitIn(wt.path);
  const open = JSON.parse(pulls({ merged: false })) as unknown[];
  process.env.GH_MARK = mark;
  process.env.GH_ANSWER = JSON.stringify(Array.from({ length: 100 }, () => open[0]));
  process.env.GH_ANSWER_2 = pulls({});
  try {
    const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
    assert.equal(outcome?.result, "removed", outcome?.reason);
    assert.equal(outcome?.reason, "pull_request");
    assert.match(readFileSync(mark, "utf8"), /commits\/[0-9a-f]+\/pulls\?per_page=100&page=2/);
  } finally {
    delete process.env.GH_MARK;
    delete process.env.GH_ANSWER;
    delete process.env.GH_ANSWER_2;
  }
  assertNoTrace(h);
});

test("a merged pull request the commit's list leaves out is found by search, and read for its exact head and base", async () => {
  const mark = join(dir, `gh-mark-${++counter}`);
  const h = harness(makeRepo(), fakeGh());
  const wt = await created(h);
  commitIn(wt.path);
  const tip = git(h.repo, "rev-parse", wt.branch);
  const pull = (pr: { base?: string; head?: string; merged?: boolean }): string => JSON.stringify((JSON.parse(pulls({ head: tip, ...pr })) as unknown[])[0]);
  process.env.GH_MARK = mark;
  // GitHub lists only open pull requests for a commit off the default branch.
  process.env.GH_ANSWER = "[]";
  process.env.GH_SEARCH = JSON.stringify({ total_count: 1, items: [{ number: 184 }] });
  try {
    for (const wrong of [pull({ head: git(h.repo, "rev-parse", "main") }), pull({ base: "release" }), pull({ merged: false }), "not json"]) {
      process.env.GH_PULL = wrong;
      assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained", wrong);
    }
    delete process.env.GH_PULL;
    assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained", "a pull request gh cannot read");
    process.env.GH_PULL = pull({});
    const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
    assert.equal(outcome?.result, "removed", outcome?.reason);
    assert.equal(outcome?.reason, "pull_request");
    const asked = readFileSync(mark, "utf8");
    assert.match(asked, new RegExp(`search/issues\\?q=repo:\\{owner\\}/\\{repo\\}\\+is:pr\\+is:merged\\+${tip}`));
    assert.match(asked, /repos\/\{owner\}\/\{repo\}\/pulls\/184/);
  } finally {
    delete process.env.GH_MARK;
    delete process.env.GH_ANSWER;
    delete process.env.GH_SEARCH;
    delete process.env.GH_PULL;
  }
  assertNoTrace(h);
});

test("a gh that cannot answer for the commit is not asked to search", async () => {
  const mark = join(dir, `gh-mark-${++counter}`);
  const h = harness(makeRepo(), fakeGh());
  const wt = await created(h);
  commitIn(wt.path);
  process.env.GH_MARK = mark;
  process.env.GH_FAIL = "1";
  try {
    assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained");
    assert.doesNotMatch(readFileSync(mark, "utf8"), /search/);
  } finally {
    delete process.env.GH_MARK;
    delete process.env.GH_FAIL;
  }
});

test("a worktree started from a detached HEAD has no base branch to compare: a pull request merged at its exact tip still proves it, one at another head does not", async () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "--detach");
  const h = harness(repo, fakeGh());
  const wt = await created(h);
  commitIn(wt.path);
  try {
    process.env.GH_ANSWER = pulls({ head: git(repo, "rev-parse", "HEAD") });
    assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained");
    process.env.GH_ANSWER = pulls({ merged: false });
    assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained");
    process.env.GH_ANSWER = pulls({ base: "release" });
    const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
    assert.equal(outcome?.result, "removed", outcome?.reason);
    assert.equal(outcome?.reason, "pull_request");
  } finally {
    delete process.env.GH_ANSWER;
  }
  assert.ok(!existsSync(wt.path));
  assert.ok(!branches(repo).includes(wt.branch));
});

test("a declaration covers the tip it was made of: commits made after it are kept", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  await h.worktrees.declareIntegratedFor("agent-1", "agent");
  commitIn(wt.path, "later.txt");
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "retained");
  assert.ok(branches(h.repo).includes(wt.branch));
});

test("a pull request merged at an older tip does not cover commits pushed after it", async () => {
  const h = harness(makeRepo(), fakeGh());
  const wt = await created(h);
  commitIn(wt.path);
  process.env.GH_ANSWER = pulls({ head: "0000000000000000000000000000000000000000" });
  try {
    assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained");
    process.env.GH_ANSWER = pulls({});
    assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "removed");
  } finally {
    delete process.env.GH_ANSWER;
  }
  assertNoTrace(h);
});

test("commits made on a detached HEAD in the worktree are on no branch: retained, not lost", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  git(h.repo, "merge", "-q", "--no-edit", wt.branch);
  git(wt.path, "checkout", "-q", "--detach");
  commitIn(wt.path, "stray.txt");
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "retained");
  assert.match(outcome?.reason ?? "", /no branch/);
  assert.ok(existsSync(join(wt.path, "stray.txt")));
});

test("an agent that starts a turn while the decision is being made keeps its worktree", async () => {
  const h = harness(makeRepo(), fakeGh());
  const wt = await created(h);
  commitIn(wt.path);
  process.env.GH_ANSWER = pulls({});
  process.env.GH_SLEEP = "1";
  try {
    setTimeout(() => (h.agent.busy = true), 300);
    const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
    assert.equal(outcome?.result, "skipped");
    assert.ok(existsSync(wt.path));
  } finally {
    delete process.env.GH_ANSWER;
    delete process.env.GH_SLEEP;
  }
});

test("a file git ignores and cannot rebuild keeps the worktree; a build folder does not", async () => {
  const h = harness();
  const wt = await created(h);
  writeFileSync(join(wt.path, ".gitignore"), ".env\nnode_modules/\n");
  git(wt.path, "add", "-A");
  git(wt.path, "commit", "-q", "-m", "ignore");
  git(h.repo, "merge", "-q", "--no-edit", wt.branch);
  mkdirSync(join(wt.path, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(wt.path, "node_modules", "dep", "i.js"), "x");
  writeFileSync(join(wt.path, ".env"), "SECRET=1\n");
  assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained");
  assert.equal(readFileSync(join(wt.path, ".env"), "utf8"), "SECRET=1\n");
  rmSync(join(wt.path, ".env"));
  assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "removed");
  assertNoTrace(h);
});

test("a worktrees folder reached through a symlink: a folder deleted by hand is still forgotten and its branch removed", async () => {
  const h = harness();
  const real = join(dir, `real-root-${++counter}`);
  mkdirSync(real);
  const link = join(dir, `link-root-${++counter}`);
  symlinkSync(real, link);
  const registryFile = join(dir, `registry-link-${counter}.json`);
  const worktrees = new RoomWorktrees({ registry: new WorktreeRegistry(registryFile), root: link, gh: "/nonexistent/gh", agents: { facts: () => ({ ...h.agent, title: "Linked", cwd: h.repo, roomId: "room" }) } });
  const wt = await worktrees.create("room", "agent-1", h.repo);
  assert.ok(wt.ok);
  commitIn(wt.path);
  git(h.repo, "merge", "-q", "--no-edit", wt.branch);
  rmSync(wt.path, { recursive: true });
  assert.deepEqual((await worktrees.sweep()).map((o) => o.result), ["removed"]);
  assert.deepEqual(branches(h.repo), ["main"]);
  assert.equal(git(h.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
});

test("a worktree created from the person's own linked worktree is still cleaned up after they remove theirs", async () => {
  const h = harness();
  const theirs = join(dir, `theirs-${++counter}`);
  git(h.repo, "worktree", "add", "-q", "-b", "feature/theirs", theirs);
  const wt = await created(h, theirs);
  commitIn(wt.path);
  git(theirs, "merge", "-q", "--no-edit", wt.branch);
  git(h.repo, "worktree", "remove", "--force", theirs);
  const [outcome] = await h.worktrees.cleanupAgent("agent-1", { auto: true });
  assert.equal(outcome?.result, "removed", outcome?.reason);
  assert.deepEqual(branches(h.repo), ["feature/theirs", "main"]);
});

test("a creation killed inside git worktree add, leaving a bare folder git never registered, is swept away", async () => {
  const h = harness();
  const path = join(h.root, "app", "half-1234");
  mkdirSync(path, { recursive: true });
  h.registry.put({ id: "half", repoRoot: h.repo, path, branch: "anywh/half-1234", base: { ref: "main", sha: git(h.repo, "rev-parse", "HEAD") }, roomId: "room", agentId: "agent-1", createdAt: 1, state: "creating" });
  await h.worktrees.sweep();
  assertNoTrace(h);
});

test("creating refuses what is not a repository, a repository's own worktree, and names are never reused", async () => {
  const h = harness();
  const plain = join(dir, `plain-${++counter}`);
  mkdirSync(plain);
  const refused = await h.worktrees.create("room", "agent-1", plain);
  assert.equal(refused.ok, false);
  const wt = await created(h);
  const nested = await h.worktrees.create("room", "agent-1", wt.path);
  assert.equal(nested.ok ? "" : nested.error, "that path is already an agent's worktree; name the original repository");
  const many = await Promise.all(Array.from({ length: 6 }, () => h.worktrees.create("room", "agent-1", h.repo)));
  const names = many.map((r) => (r.ok ? r.branch : "x"));
  assert.equal(new Set([...names, wt.branch]).size, 7);
  assert.equal(h.registry.all().length, 7);
});

// ------------------------------------------------------------- crashes

function crash(h: Harness, point: string, action: "create" | "cleanup"): void {
  const r = spawnSync(process.execPath, ["--import", "tsx", resolve("tests/fixtures/worktreeCrash.ts"), JSON.stringify({ registryFile: h.registryFile, root: h.root, repo: h.repo, point, action })], { encoding: "utf8" });
  assert.equal(r.status, 77, `the process crashed at ${point}: ${r.stdout}${r.stderr}`);
}

for (const point of ["afterIntent", "afterAdd"]) {
  test(`a crash of the process ${point === "afterIntent" ? "after the intention is recorded, before git worktree add" : "after the worktree exists, before it is confirmed"} leaves zero orphans after the next start`, async () => {
    const h = harness();
    crash(h, point, "create");
    // A fresh process reads the same registry file and folder.
    const fresh = new RoomWorktrees({ registry: new WorktreeRegistry(h.registryFile), root: h.root, agents: { facts: () => ({ exists: true, busy: false, done: true }) }, gh: "/nonexistent/gh" });
    assert.equal(new WorktreeRegistry(h.registryFile).all()[0]?.state, "creating");
    await fresh.sweep();
    assertNoTrace(h);
  });
}

for (const point of ["afterRemoving", "afterWorktreeRemoved"]) {
  test(`a crash of the process ${point === "afterRemoving" ? "after a removal is decided, before anything is removed" : "between git worktree remove and git branch -D"} is finished by the next start`, async () => {
    const h = harness();
    const wt = await created(h);
    commitIn(wt.path);
    git(h.repo, "merge", "-q", "--no-edit", wt.branch);
    crash(h, point, "cleanup");
    assert.equal(new WorktreeRegistry(h.registryFile).all()[0]?.state, "removing");
    const fresh = new RoomWorktrees({ registry: new WorktreeRegistry(h.registryFile), root: h.root, agents: { facts: () => ({ exists: true, busy: false, done: true }) }, gh: "/nonexistent/gh" });
    await fresh.sweep();
    assertNoTrace(h);
  });
}

test("a removal decided before a crash is not carried out for commits made after it: the worktree is kept and decided on again", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  git(h.repo, "merge", "-q", "--no-edit", wt.branch);
  crash(h, "afterRemoving", "cleanup");
  // The agent kept running in the host while the relay was down.
  commitIn(wt.path, "after-the-crash.txt");
  const fresh = new RoomWorktrees({ registry: new WorktreeRegistry(h.registryFile), root: h.root, agents: { facts: () => ({ exists: true, busy: false, done: true }) }, gh: "/nonexistent/gh" });
  const [outcome] = await fresh.sweep();
  assert.equal(outcome?.result, "retained");
  assert.match(outcome?.reason ?? "", /moved/);
  assert.ok(existsSync(join(wt.path, "after-the-crash.txt")));
  assert.ok(branches(h.repo).includes(wt.branch));
  assert.equal(new WorktreeRegistry(h.registryFile).all()[0]?.state, "retained");
});

test("gh is not asked about a worktree that cannot be removed anyway", async () => {
  const mark = join(dir, `gh-mark-${++counter}`);
  process.env.GH_MARK = mark;
  process.env.GH_ANSWER = pulls({});
  try {
    const h = harness(makeRepo(), fakeGh());
    const wt = await created(h);
    commitIn(wt.path);
    h.agent.busy = true;
    assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "skipped");
    h.agent.busy = false;
    writeFileSync(join(wt.path, "dirty.txt"), "x");
    assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained");
    assert.equal(existsSync(mark), false, "gh was never called");
    rmSync(join(wt.path, "dirty.txt"));
    assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "removed");
    assert.equal(existsSync(mark), true);
  } finally {
    delete process.env.GH_MARK;
    delete process.env.GH_ANSWER;
  }
});

test("a crash during creation of a worktree that already holds commits would never lose them: it is retained", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  // The record is put back to `creating`, as if the confirmation never landed.
  h.registry.put({ ...h.registry.all()[0], state: "creating" });
  await new RoomWorktrees({ registry: new WorktreeRegistry(h.registryFile), root: h.root, agents: { facts: () => ({ exists: true, busy: false, done: true }) }, gh: "/nonexistent/gh" }).sweep();
  assert.ok(branches(h.repo).includes(wt.branch), "the commit's branch survives");
});
