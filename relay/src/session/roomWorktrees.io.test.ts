// The worktree cycle against real git in throwaway repositories: no model, no
// mocks. A worktree is created for an agent, worked in, integrated by the
// ways a person integrates (merge, squash), and removed; and through every
// path, including a crash between any two steps, nothing is left behind and
// nothing that anywh did not create is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a squash merge leaves no ancestor: retained without a declaration (gh absent), removed with one", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  git(h.repo, "merge", "--squash", wt.branch);
  git(h.repo, "commit", "-q", "-m", "squashed");
  assert.equal((await h.worktrees.cleanupAgent("agent-1", { auto: true }))[0]?.result, "retained", "no evidence git can see, nothing is deleted");
  assert.ok(existsSync(wt.path));
  h.worktrees.declareIntegratedFor("agent-1", "agent");
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

test("a crash during creation of a worktree that already holds commits would never lose them: it is retained", async () => {
  const h = harness();
  const wt = await created(h);
  commitIn(wt.path);
  // The record is put back to `creating`, as if the confirmation never landed.
  h.registry.put({ ...h.registry.all()[0], state: "creating" });
  await new RoomWorktrees({ registry: new WorktreeRegistry(h.registryFile), root: h.root, agents: { facts: () => ({ exists: true, busy: false, done: true }) }, gh: "/nonexistent/gh" }).sweep();
  assert.ok(branches(h.repo).includes(wt.branch), "the commit's branch survives");
});
