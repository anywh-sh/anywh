import assert from "node:assert/strict";
import { test } from "node:test";
import { decideCleanup, isInside, isOurs, pathFor, slugify, worktreeName, branchFor, type CleanupFacts } from "./worktreePolicy.js";

const facts = (over: Partial<CleanupFacts> = {}): CleanupFacts => ({
  agentBusy: false,
  agentDone: true,
  discard: false,
  ancestor: false,
  declaredIntegrated: false,
  strayCommits: false,
  squashed: false,
  prMerged: false,
  worktreeExists: true,
  clean: true,
  hasSubmodules: false,
  ...over,
});

test("names are lowercase slugs with a short suffix, under the anywh/ prefix", () => {
  assert.equal(slugify("Fix the Cart — Checkout!"), "fix-the-cart-checkout");
  assert.equal(slugify("Ação é nossa"), "acao-e-nossa");
  assert.equal(slugify("!!!"), "agent");
  assert.ok(slugify("x".repeat(100)).length <= 30);
  assert.equal(worktreeName("Fix cart", "a1b2"), "fix-cart-a1b2");
  assert.equal(branchFor("fix-cart-a1b2"), "anywh/fix-cart-a1b2");
  assert.equal(pathFor("/h/.anywh/worktrees", "/work/My App", "fix-cart-a1b2"), "/h/.anywh/worktrees/my-app/fix-cart-a1b2");
});

test("only a record under the worktrees folder with the anywh/ prefix is ours", () => {
  const root = "/h/.anywh/worktrees";
  assert.equal(isOurs({ path: "/h/.anywh/worktrees/app/x-1111", branch: "anywh/x-1111" }, root), true);
  assert.equal(isOurs({ path: "/home/me/code/app", branch: "anywh/x-1111" }, root), false, "a path outside the folder");
  assert.equal(isOurs({ path: "/h/.anywh/worktrees/app/x", branch: "feature/mine" }, root), false, "a branch without the prefix");
  assert.equal(isOurs({ path: "/h/.anywh/worktrees", branch: "anywh/x" }, root), false, "the folder itself");
  assert.equal(isOurs({ path: "/h/.anywh/worktrees/../../etc", branch: "anywh/x" }, root), false);
  assert.equal(isOurs({ path: "/h/.anywh/worktrees/a/b", branch: "anywh/" }, root), false);
  assert.equal(isInside("/a/b", "/a/bc"), false);
});

test("nothing is removed without evidence; every kind of evidence removes a clean worktree", () => {
  assert.deepEqual(decideCleanup(facts(), true), { action: "retain", reason: "its branch is not merged into its base, and nobody said it was integrated" });
  assert.deepEqual(decideCleanup(facts({ ancestor: true }), true), { action: "remove", evidence: "ancestor", force: false });
  assert.deepEqual(decideCleanup(facts({ declaredIntegrated: true }), true), { action: "remove", evidence: "declared", force: false });
  assert.deepEqual(decideCleanup(facts({ squashed: true }), true), { action: "remove", evidence: "squash", force: false });
  assert.deepEqual(decideCleanup(facts({ prMerged: true }), true), { action: "remove", evidence: "pull_request", force: false });
});

test("the evidence named is the strongest one held: ancestor, then declared, then squash, then pull request", () => {
  const all = { ancestor: true, declaredIntegrated: true, squashed: true, prMerged: true };
  assert.equal((decideCleanup(facts(all), true) as { evidence: string }).evidence, "ancestor");
  assert.equal((decideCleanup(facts({ ...all, ancestor: false }), true) as { evidence: string }).evidence, "declared");
  assert.equal((decideCleanup(facts({ ...all, ancestor: false, declaredIntegrated: false }), true) as { evidence: string }).evidence, "squash");
  assert.equal((decideCleanup(facts({ squashed: false, prMerged: true }), true) as { evidence: string }).evidence, "pull_request");
});

test("evidence does not remove a worktree with uncommitted changes or an initialized submodule", () => {
  assert.equal(decideCleanup(facts({ ancestor: true, clean: false }), true).action, "retain");
  assert.equal(decideCleanup(facts({ declaredIntegrated: true, hasSubmodules: true }), true).action, "retain");
  assert.equal(decideCleanup(facts({ squashed: true, clean: false }), true).action, "retain");
  assert.equal(decideCleanup(facts({ squashed: true, hasSubmodules: true }), true).action, "retain");
});

test("a squash found by patch does not cover commits held off the branch", () => {
  assert.equal(decideCleanup(facts({ squashed: true, strayCommits: true }), true).action, "retain");
  assert.equal(decideCleanup(facts({ squashed: true, agentDone: false }), true).action, "skip");
  assert.equal(decideCleanup(facts({ squashed: true, agentBusy: true }), false).action, "skip");
});

test("an agent at work, or (for automatic cleanup) not done, is left alone; a discard forces", () => {
  assert.equal(decideCleanup(facts({ agentBusy: true, ancestor: true }), false).action, "skip");
  assert.equal(decideCleanup(facts({ agentBusy: true, discard: true }), false).action, "skip");
  assert.equal(decideCleanup(facts({ agentDone: false, ancestor: true }), true).action, "skip");
  assert.equal(decideCleanup(facts({ agentDone: false, ancestor: true }), false).action, "remove");
  assert.deepEqual(decideCleanup(facts({ discard: true, clean: false, hasSubmodules: true }), false), { action: "remove", evidence: "discard", force: true });
});
