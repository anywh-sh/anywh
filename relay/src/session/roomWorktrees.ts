// The worktrees of a room's agents: created on request (`worktree_create`),
// recorded before anything is touched, and cleaned up when the work in them is
// safe elsewhere. The rules are host/worktreePolicy.ts; the git calls
// host/worktreeGit.ts; this file orders them and keeps the record in step.
//
// A worktree and its branch are removed only when the branch is merged into
// the base it started from, or someone said its work was integrated, or its
// whole work is on the base's tip as a squash or rebase merge (which leave no
// ancestor for git to see), or a pull request into the base was merged with
// the branch's exact tip as its head, and its worktree is clean. Without such evidence it is retained, with the
// reason. Only "discard anyway", asked for by a person, forces. Only records
// of this registry, under the worktrees folder and carrying the `anywh/`
// branch prefix, are ever acted on: the person's own worktrees and branches
// are never touched, whatever they are named.
//
// Every operation runs one at a time, and a crash anywhere leaves a record
// saying what was in progress; `sweep` finishes or undoes it at the next start.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { baseTip, branchExists, branchTip, commitsAhead, deleteBranch, directorySize, forgetMissingWorktree, hasInitializedSubmodules, initSubmodules, isAncestorOfBase, isClean, isCommitInBase, listWorktrees, pullRequestMerged, readRepo, removeWorktree, addWorktree, squashedIntoBase, worktreeHead } from "../host/worktreeGit.js";
import type { WorktreeRegistry } from "../host/worktreeRegistry.js";
import { branchFor, decideCleanup, isInside, isOurs, pathFor, worktreeName, type CleanupDecision, type WorktreeRecord } from "../host/worktreePolicy.js";
import { join } from "node:path";

/** What the worktrees need to know about an agent. */
export interface WorktreeAgents {
  /** `exists` is false for a session that is gone. */
  facts(agentId: string): { exists: boolean; busy: boolean; done: boolean; title?: string; cwd?: string; roomId?: string };
}

export interface RoomWorktreesOptions {
  readonly registry: WorktreeRegistry;
  /** Folder every worktree lives under, outside every repository. */
  readonly root: string;
  readonly agents: WorktreeAgents;
  /** The `gh` binary asked about pull requests. */
  readonly gh?: string;
  readonly now?: () => number;
  /** Called at the points between two steps a crash could fall on. A test
   * makes it exit the process there; nothing else sets it. */
  readonly crashPoint?: (point: "afterIntent" | "afterAdd" | "afterRemoving" | "afterWorktreeRemoved") => void;
}

export type CreateWorktreeResult =
  | { ok: true; path: string; workdir: string; branch: string; base: string; warnings: string[] }
  | { ok: false; error: string };

export type CleanupOutcome = { id: string; branch: string; result: "removed" | "retained" | "skipped"; reason?: string };

export interface WorktreeInfo {
  id: string;
  agentId: string;
  repoRoot: string;
  path: string;
  branch: string;
  state: WorktreeRecord["state"];
  /** `in_use` while the agent has a turn running. */
  phase: "in_use" | "idle";
  commitsAhead?: number;
  clean?: boolean;
  integrated: boolean;
  retainedReason?: string;
  sizeBytes?: number;
}

export class RoomWorktrees {
  private chain: Promise<unknown> = Promise.resolve();
  /** Records being created or removed by this process right now. */
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;
  /** Proofs of integration already established, per record: a squash found
   * for a branch tip against a base tip, and a merged pull request found for
   * a branch tip. Either is only reused while those tips are unchanged, so
   * `list` reports what cleanup would find without asking again. */
  private readonly proofs = new Map<string, { squash?: { tip: string; baseTip: string; found: boolean }; pullRequestTip?: string }>();

  /** The worktrees folder as git reports paths under it (symlinks resolved). */
  private readonly rootDir: string;

  constructor(private readonly options: RoomWorktreesOptions) {
    this.now = options.now ?? Date.now;
    mkdirSync(options.root, { recursive: true });
    this.rootDir = realpathSync(options.root);
  }

  /** One git operation at a time, whatever the callers. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  get root(): string {
    return this.rootDir;
  }

  /** Where git still answers for a record: its checkout, or the common git
   * dir when the checkout named is gone (the person's own linked worktree,
   * removed). */
  private repoDirOf(record: WorktreeRecord): string | undefined {
    if (existsSync(record.repoRoot)) return record.repoRoot;
    return record.commonDir && existsSync(record.commonDir) ? record.commonDir : undefined;
  }

  /** The record as it is now on disk: writes of a snapshot must not undo a
   * declaration made while an operation was awaiting git. */
  private fresh(record: WorktreeRecord): WorktreeRecord {
    const current = this.options.registry.get(record.id);
    return current ? { ...record, ...(current.declaredIntegrated ? { declaredIntegrated: current.declaredIntegrated } : {}) } : record;
  }

  // ---------------------------------------------------------------- create

  /** A worktree of `repo` (a path, relative to the agent's folder) for the
   * agent, on a new branch from the repo's current HEAD. */
  create(roomId: string, agentId: string, repo: string): Promise<CreateWorktreeResult> {
    return this.serial(() => this.createNow(roomId, agentId, repo));
  }

  private async createNow(roomId: string, agentId: string, repo: string): Promise<CreateWorktreeResult> {
    const agent = this.options.agents.facts(agentId);
    const from = repo.startsWith("/") ? repo : join(agent.cwd ?? "/", repo);
    const facts = await readRepo(from);
    if ("error" in facts) return { ok: false, error: facts.error };
    if (isInside(this.rootDir, facts.root)) return { ok: false, error: "that path is already an agent's worktree; name the original repository" };
    let name = "";
    let path = "";
    let branch = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      name = worktreeName(agent.title ?? "agent", randomBytes(2).toString("hex"));
      path = pathFor(this.rootDir, facts.root, name);
      branch = branchFor(name);
      if (!existsSync(path) && !(await branchExists(facts.root, branch)) && !this.options.registry.all().some((r) => r.path === path || r.branch === branch)) break;
      name = "";
    }
    if (name === "") return { ok: false, error: "could not find a free name for the worktree" };

    const record: WorktreeRecord = { id: randomBytes(8).toString("hex"), repoRoot: facts.root, commonDir: facts.commonDir, path, branch, base: facts.base, roomId, agentId, createdAt: this.now(), state: "creating" };
    // The intention goes to disk first: a crash after this line is undone by `sweep`.
    this.options.registry.put(record);
    this.options.crashPoint?.("afterIntent");
    this.inFlight.add(record.id);
    try {
      mkdirSync(join(path, ".."), { recursive: true });
      const added = await addWorktree(facts.root, path, branch, facts.base.sha);
      this.options.crashPoint?.("afterAdd");
      if (!added.ok) {
        await this.undoCreation(record);
        return { ok: false, error: `git could not create the worktree: ${added.stderr.trim() || added.stdout.trim()}` };
      }
      const warnings: string[] = [];
      const submodules = await initSubmodules(path);
      if (submodules && !submodules.ok) warnings.push(`its submodules could not be initialized (${submodules.stderr.trim().split("\n").pop() ?? "git failed"}); run git submodule update --init there`);
      this.options.registry.put({ ...this.fresh(record), state: "created" });
      return { ok: true, path, workdir: facts.subpath ? join(path, facts.subpath) : path, branch, base: facts.base.ref ?? facts.base.sha, warnings };
    } catch (error) {
      await this.undoCreation(record);
      return { ok: false, error: `could not create the worktree: ${(error as Error).message}` };
    } finally {
      this.inFlight.delete(record.id);
    }
  }

  /** Takes back a creation that did not finish: what exists of the worktree
   * and its (empty) branch goes, then the record. */
  private async undoCreation(record: WorktreeRecord): Promise<void> {
    const repo = this.repoDirOf(record);
    if (!isOurs(record, this.rootDir) || !repo) {
      // Not ours to act on, or nowhere left to ask git: only the record goes
      // when it names nothing that exists.
      if (!isOurs(record, this.rootDir) || (!existsSync(record.path))) this.options.registry.delete(record.id);
      else this.options.registry.put({ ...record, state: "retained", retained: { reason: "its creation did not finish and its repository is not where it was", at: this.now() } });
      return;
    }
    const listed = (await listWorktrees(repo)).some((entry) => entry.path === record.path);
    if (listed) await removeWorktree(repo, record.path, true);
    else {
      const common = (await readRepo(repo)) as { commonDir?: string };
      if (common.commonDir) forgetMissingWorktree(common.commonDir, record.path);
      // A directory git never registered (killed in the middle of `worktree
      // add`) holds nothing of anyone's: it is ours, under our folder, new.
      if (existsSync(record.path) && !existsSync(join(record.path, ".git"))) rmSync(record.path, { recursive: true, force: true });
    }
    // Only a branch still at its starting point: one with commits is work.
    if ((await branchTip(repo, record.branch)) === record.base.sha) await deleteBranch(repo, record.branch);
    if (!(await branchExists(repo, record.branch)) && !existsSync(record.path)) this.options.registry.delete(record.id);
    else this.options.registry.put({ ...this.fresh(record), state: "retained", retained: { reason: "its creation did not finish and it holds something", at: this.now() } });
  }

  // --------------------------------------------------------------- cleanup

  /** Someone says a worktree's branch was integrated. Said of the tip it has
   * now: commits made after are not covered. */
  declareIntegrated(id: string, by: "agent" | "user"): Promise<boolean> {
    return this.serial(async () => {
      const record = this.options.registry.get(id);
      if (!record) return false;
      const repo = this.repoDirOf(record);
      const tip = repo ? await branchTip(repo, record.branch) : undefined;
      this.options.registry.put({ ...(this.options.registry.get(id) ?? record), declaredIntegrated: { by, at: this.now(), ...(tip ? { tip } : {}) } });
      return true;
    });
  }

  /** The agent says its worktrees' work was integrated. */
  async declareIntegratedFor(agentId: string, by: "agent" | "user"): Promise<void> {
    for (const record of this.options.registry.forAgent(agentId)) await this.declareIntegrated(record.id, by);
  }

  /** Cleans up one agent's worktrees. `auto` (a worker's turn ended, the
   * room closed, a sweep) only takes those of agents that are done. */
  cleanupAgent(agentId: string, options: { auto: boolean }): Promise<CleanupOutcome[]> {
    return this.serial(async () => this.cleanupRecords(this.options.registry.forAgent(agentId), { auto: options.auto, discard: false }));
  }

  cleanupRoom(roomId: string, options: { auto: boolean }): Promise<CleanupOutcome[]> {
    return this.serial(async () => this.cleanupRecords(this.options.registry.forRoom(roomId), { auto: options.auto, discard: false }));
  }

  /** The person's "discard anyway": the one way to force. */
  discard(id: string): Promise<CleanupOutcome | undefined> {
    return this.serial(async () => {
      const record = this.options.registry.get(id);
      return record ? (await this.cleanupRecords([record], { auto: false, discard: true }))[0] : undefined;
    });
  }

  private async cleanupRecords(records: readonly WorktreeRecord[], mode: { auto: boolean; discard: boolean }): Promise<CleanupOutcome[]> {
    const outcomes: CleanupOutcome[] = [];
    for (const record of records) {
      if (record.state === "creating" || this.inFlight.has(record.id)) continue;
      if (!isOurs(record, this.rootDir)) {
        this.options.registry.delete(record.id);
        continue;
      }
      outcomes.push(await this.cleanupOne(record, mode));
    }
    return outcomes;
  }

  /** Whether the branch's work at `tip` is on the base by content (a squash
   * or rebase merge), remembered for that tip and the base's current tip. */
  private async squashed(record: WorktreeRecord, repo: string, tip: string): Promise<boolean> {
    const onBase = await baseTip(repo, record.base);
    if (!onBase) return false;
    const known = this.proofs.get(record.id)?.squash;
    if (known && known.tip === tip && known.baseTip === onBase) return known.found;
    const found = await squashedIntoBase(repo, tip, record.base);
    this.proofs.set(record.id, { ...this.proofs.get(record.id), squash: { tip, baseTip: onBase, found } });
    return found;
  }

  private async pullRequestMerged(record: WorktreeRecord, repo: string, tip: string | undefined): Promise<boolean> {
    const merged = await pullRequestMerged(repo, tip, record.base, this.options.gh);
    if (merged && tip) this.proofs.set(record.id, { ...this.proofs.get(record.id), pullRequestTip: tip });
    return merged;
  }

  private async decide(record: WorktreeRecord, mode: { auto: boolean; discard: boolean }): Promise<CleanupDecision> {
    const agent = this.options.agents.facts(record.agentId);
    // The cheap refusals first: nothing below (git, `gh`) is asked for them.
    if (agent.busy) return { action: "skip", reason: "the agent has a turn running" };
    if (mode.auto && agent.exists && !agent.done) return { action: "skip", reason: "the agent is not done" };
    const repo = this.repoDirOf(record);
    const worktreeExists = existsSync(record.path);
    const branchThere = repo !== undefined && (await branchExists(repo, record.branch));
    const tip = branchThere && repo ? await branchTip(repo, record.branch) : undefined;
    // A git that would not say what the branch is at decides nothing.
    if (branchThere && tip === undefined) return { action: "skip", reason: "git could not read its branch" };
    // A branch still at its starting point is trivially "merged", which says
    // nothing while its agent may yet use it: left alone until it moves, or
    // its agent is gone, or someone says it is done with.
    if (tip === record.base.sha && agent.exists && !mode.discard && record.declaredIntegrated === undefined) {
      return { action: "skip", reason: "nothing has been committed in it yet" };
    }
    // A branch that is already gone has no work left to lose.
    const ancestor = repo === undefined || !branchThere ? true : await isAncestorOfBase(repo, record.branch, record.base);
    const declared = record.declaredIntegrated !== undefined && record.declaredIntegrated.tip === tip;
    // Commits made in the worktree off its branch (a detached HEAD) are on no
    // branch to look at: only a base that already holds them makes them safe.
    let strayCommits = false;
    if (worktreeExists && repo) {
      const head = await worktreeHead(record.path);
      if (head && head.sha !== tip) strayCommits = !(await isCommitInBase(repo, head.sha, record.base));
    }
    const clean = worktreeExists ? await isClean(record.path) : true;
    const hasSubmodules = worktreeExists ? await hasInitializedSubmodules(record.path) : false;
    // The proofs below are asked only when the rest would allow a removal:
    // a worktree that is dirty, holds stray commits or a submodule is
    // retained whatever they say.
    const removable = repo !== undefined && !ancestor && !declared && !mode.discard && !strayCommits && clean && !hasSubmodules;
    // A squash or rebase merge, found by content: git alone, no network.
    const squashed = removable && tip !== undefined ? await this.squashed(record, repo, tip) : false;
    // Last: it is the slow one.
    const askPullRequest = removable && !squashed;
    return decideCleanup(
      {
        agentBusy: agent.busy,
        agentDone: !agent.exists || agent.done,
        discard: mode.discard,
        ancestor,
        declaredIntegrated: declared,
        strayCommits,
        squashed,
        prMerged: askPullRequest ? await this.pullRequestMerged(record, repo, tip) : false,
        worktreeExists,
        clean,
        hasSubmodules,
      },
      mode.auto,
    );
  }

  private async cleanupOne(record: WorktreeRecord, mode: { auto: boolean; discard: boolean }): Promise<CleanupOutcome> {
    const decision = await this.decide(record, mode);
    if (decision.action === "skip") return { id: record.id, branch: record.branch, result: "skipped", reason: decision.reason };
    if (decision.action === "retain") {
      // A directory the person deleted by hand leaves a stale entry in git's
      // own list: forgotten here, that one entry only (the branch stays).
      const repo = this.repoDirOf(record);
      if (!existsSync(record.path) && repo) {
        const facts = await readRepo(repo);
        if (!("error" in facts)) forgetMissingWorktree(facts.commonDir, record.path);
      }
      this.options.registry.put({ ...this.fresh(record), state: "retained", retained: { reason: decision.reason, at: this.now() } });
      return { id: record.id, branch: record.branch, result: "retained", reason: decision.reason };
    }
    // The decision took awaits (git, `gh`): the agent may have a turn now.
    if (this.options.agents.facts(record.agentId).busy) return { id: record.id, branch: record.branch, result: "skipped", reason: "the agent has a turn running" };
    // The decision is on disk before the first removal.
    const repo = this.repoDirOf(record);
    const tip = repo ? await branchTip(repo, record.branch) : undefined;
    const removing: WorktreeRecord = { ...this.fresh(record), state: "removing", removing: { force: decision.force, reason: decision.evidence, ...(tip ? { tip } : {}) } };
    this.options.registry.put(removing);
    this.options.crashPoint?.("afterRemoving");
    this.inFlight.add(record.id);
    try {
      return await this.finishRemoval(removing);
    } finally {
      this.inFlight.delete(record.id);
    }
  }

  /** Takes back a removal decided of work that has since changed: it becomes
   * a retained worktree, to be decided on again at the next cleanup. */
  private reopen(record: WorktreeRecord, reason: string): CleanupOutcome {
    const { removing: _removing, ...rest } = this.fresh(record);
    void _removing;
    this.options.registry.put({ ...rest, state: "retained", retained: { reason, at: this.now() } });
    return { id: record.id, branch: record.branch, result: "retained", reason };
  }

  /** Carries out a removal already decided: the worktree, then the branch,
   * then the record. Safe to run again after a crash at any step. */
  private async finishRemoval(record: WorktreeRecord): Promise<CleanupOutcome> {
    const force = record.removing?.force ?? false;
    const refuse = (reason: string): CleanupOutcome => {
      this.options.registry.put({ ...this.fresh(record), state: "retained", retained: { reason, at: this.now() } });
      return { id: record.id, branch: record.branch, result: "retained", reason };
    };
    // A removal resumed after a crash may meet an agent that is working again.
    if (this.options.agents.facts(record.agentId).busy) return { id: record.id, branch: record.branch, result: "skipped", reason: "the agent has a turn running" };
    const repo = this.repoDirOf(record);
    if (!repo) return refuse("its repository is not where it was");
    // The decision was for the work the branch held then. A removal resumed
    // after a crash (the agent may have gone on committing meanwhile) is
    // not for newer commits: they are decided on again, from the start.
    const moved = async (): Promise<boolean> => !force && record.removing?.tip !== undefined && (await branchExists(repo, record.branch)) && (await branchTip(repo, record.branch)) !== record.removing.tip;
    if (await moved()) return this.reopen(record, "its branch moved after the removal was decided");
    // Nor for files made since that git itself would delete unasked (ignored ones).
    if (!force && existsSync(record.path) && !(await isClean(record.path))) return this.reopen(record, "its worktree changed after the removal was decided");
    if (existsSync(record.path)) {
      const removed = await removeWorktree(repo, record.path, force);
      if (!removed.ok && existsSync(record.path)) return refuse(removed.stderr.trim() || "git refused to remove it");
    } else {
      const facts = await readRepo(repo);
      if (!("error" in facts)) forgetMissingWorktree(facts.commonDir, record.path);
    }
    this.options.crashPoint?.("afterWorktreeRemoved");
    if (await moved()) return this.reopen(record, "its branch moved after the removal was decided");
    if (await branchExists(repo, record.branch)) {
      // `-D`, on the evidence already established (or the person's discard):
      // `-d` judges by the checkout's HEAD, not the base the branch started from.
      const deleted = await deleteBranch(repo, record.branch);
      if (!deleted.ok) return refuse(deleted.stderr.trim() || "git refused to delete its branch");
    }
    this.options.registry.delete(record.id);
    this.proofs.delete(record.id);
    return { id: record.id, branch: record.branch, result: "removed", reason: record.removing?.reason };
  }

  // ----------------------------------------------------------------- sweep

  /** Reconciles the registry with git and the disk: finishes or undoes what a
   * crash interrupted, forgets a worktree whose directory the person deleted,
   * and cleans up those of agents that are gone or done. Run at startup, then
   * now and then. */
  sweep(): Promise<CleanupOutcome[]> {
    return this.serial(async () => {
      const outcomes: CleanupOutcome[] = [];
      for (const record of [...this.options.registry.all()]) {
        if (this.inFlight.has(record.id)) continue;
        if (!isOurs(record, this.rootDir)) {
          this.options.registry.delete(record.id);
          continue;
        }
        if (record.state === "creating") {
          await this.undoCreation(record);
          continue;
        }
        if (record.state === "removing") {
          outcomes.push(await this.finishRemoval(record));
          continue;
        }
        outcomes.push(...(await this.cleanupRecords([record], { auto: true, discard: false })));
      }
      return outcomes;
    });
  }

  // ------------------------------------------------------------------ list

  async list(roomId: string, options: { size?: boolean } = {}): Promise<WorktreeInfo[]> {
    const infos: WorktreeInfo[] = [];
    for (const record of this.options.registry.forRoom(roomId)) {
      const exists = existsSync(record.path);
      const repo = this.repoDirOf(record);
      const branchThere = repo !== undefined && (await branchExists(repo, record.branch));
      const tip = branchThere ? await branchTip(repo, record.branch) : undefined;
      const ahead = branchThere ? await commitsAhead(repo, record.branch, record.base) : undefined;
      infos.push({
        id: record.id,
        agentId: record.agentId,
        repoRoot: record.repoRoot,
        path: record.path,
        branch: record.branch,
        state: record.state,
        phase: this.options.agents.facts(record.agentId).busy ? "in_use" : "idle",
        ...(branchThere ? { commitsAhead: ahead } : {}),
        ...(exists ? { clean: await isClean(record.path) } : {}),
        integrated: await this.integrated(record, repo, branchThere, tip, ahead),
        ...(record.retained ? { retainedReason: record.retained.reason } : {}),
        ...(options.size && exists ? { sizeBytes: await directorySize(record.path) } : {}),
      });
    }
    return infos;
  }

  /** What `list` says of a worktree's branch: the evidence cleanup accepts,
   * cheapest first. The squash search is remembered per tip, and a pull
   * request is never asked about here, only reused from a cleanup that
   * found it merged at this tip. */
  private async integrated(record: WorktreeRecord, repo: string | undefined, branchThere: boolean, tip: string | undefined, ahead: number | undefined): Promise<boolean> {
    if (record.declaredIntegrated !== undefined && record.declaredIntegrated.tip === tip) return true;
    if (!branchThere || !repo || tip === undefined) return false;
    if (await isAncestorOfBase(repo, record.branch, record.base)) return true;
    if (this.proofs.get(record.id)?.pullRequestTip === tip) return true;
    return ahead !== undefined && ahead > 0 && (await this.squashed(record, repo, tip));
  }
}
