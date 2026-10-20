// The worktrees of a room's agents: created on request (`worktree_create`),
// recorded before anything is touched, and cleaned up when the work in them is
// safe elsewhere. The rules are host/worktreePolicy.ts; the git calls
// host/worktreeGit.ts; this file orders them and keeps the record in step.
//
// A worktree and its branch are removed only when the branch is merged into
// the base it started from, or someone said its work was integrated (a squash
// merge leaves nothing for git to see), or its pull request was merged, and
// its worktree is clean. Without such evidence it is retained, with the
// reason. Only "discard anyway", asked for by a person, forces. Only records
// of this registry, under the worktrees folder and carrying the `anywh/`
// branch prefix, are ever acted on: the person's own worktrees and branches
// are never touched, whatever they are named.
//
// Every operation runs one at a time, and a crash anywhere leaves a record
// saying what was in progress; `sweep` finishes or undoes it at the next start.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { branchExists, branchTip, commitsAhead, deleteBranch, directorySize, forgetMissingWorktree, hasInitializedSubmodules, initSubmodules, isAncestorOfBase, isClean, listWorktrees, pullRequestMerged, readRepo, removeWorktree, addWorktree } from "../host/worktreeGit.js";
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

  constructor(private readonly options: RoomWorktreesOptions) {
    this.now = options.now ?? Date.now;
    mkdirSync(options.root, { recursive: true });
  }

  /** One git operation at a time, whatever the callers. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  get root(): string {
    return this.options.root;
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
    if (isInside(this.options.root, facts.root)) return { ok: false, error: "that path is already an agent's worktree; name the original repository" };
    let name = "";
    let path = "";
    let branch = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      name = worktreeName(agent.title ?? "agent", randomBytes(2).toString("hex"));
      path = pathFor(this.options.root, facts.root, name);
      branch = branchFor(name);
      if (!existsSync(path) && !(await branchExists(facts.root, branch)) && !this.options.registry.all().some((r) => r.path === path || r.branch === branch)) break;
      name = "";
    }
    if (name === "") return { ok: false, error: "could not find a free name for the worktree" };

    const record: WorktreeRecord = { id: randomBytes(8).toString("hex"), repoRoot: facts.root, path, branch, base: facts.base, roomId, agentId, createdAt: this.now(), state: "creating" };
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
      this.options.registry.put({ ...record, state: "created" });
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
    if (!isOurs(record, this.options.root)) {
      this.options.registry.delete(record.id);
      return;
    }
    const listed = (await listWorktrees(record.repoRoot)).some((entry) => entry.path === record.path);
    if (listed) await removeWorktree(record.repoRoot, record.path, true);
    else if (existsSync(record.repoRoot)) {
      const common = (await readRepo(record.repoRoot)) as { commonDir?: string };
      if (common.commonDir) forgetMissingWorktree(common.commonDir, record.path);
    }
    // Only a branch still at its starting point: one with commits is work.
    if ((await branchTip(record.repoRoot, record.branch)) === record.base.sha) await deleteBranch(record.repoRoot, record.branch);
    if (!(await branchExists(record.repoRoot, record.branch)) && !existsSync(record.path)) this.options.registry.delete(record.id);
    else this.options.registry.put({ ...record, state: "retained", retained: { reason: "its creation did not finish and it holds something", at: this.now() } });
  }

  // --------------------------------------------------------------- cleanup

  declareIntegrated(id: string, by: "agent" | "user"): boolean {
    const record = this.options.registry.get(id);
    if (!record) return false;
    this.options.registry.put({ ...record, declaredIntegrated: { by, at: this.now() } });
    return true;
  }

  /** The agent says its worktrees' work was integrated. */
  declareIntegratedFor(agentId: string, by: "agent" | "user"): void {
    for (const record of this.options.registry.forAgent(agentId)) this.declareIntegrated(record.id, by);
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
      if (!isOurs(record, this.options.root)) {
        this.options.registry.delete(record.id);
        continue;
      }
      outcomes.push(await this.cleanupOne(record, mode));
    }
    return outcomes;
  }

  private async decide(record: WorktreeRecord, mode: { auto: boolean; discard: boolean }): Promise<CleanupDecision> {
    const agent = this.options.agents.facts(record.agentId);
    const worktreeExists = existsSync(record.path);
    // A branch that is already gone has no work left to lose.
    const tip = (await this.branchStillThere(record)) ? await branchTip(record.repoRoot, record.branch) : undefined;
    // A branch still at its starting point is trivially "merged", which says
    // nothing while its agent may yet use it: left alone until it moves, or
    // its agent is gone, or someone says it is done with.
    if (tip === record.base.sha && agent.exists && !mode.discard && record.declaredIntegrated === undefined) {
      return { action: "skip", reason: "nothing has been committed in it yet" };
    }
    const ancestor = tip === undefined ? true : await isAncestorOfBase(record.repoRoot, record.branch, record.base);
    const declared = record.declaredIntegrated !== undefined;
    return decideCleanup(
      {
        agentBusy: agent.busy,
        agentDone: !agent.exists || agent.done,
        discard: mode.discard,
        ancestor,
        declaredIntegrated: declared,
        // Asked only when nothing else already proves it.
        prMerged: !ancestor && !declared && !mode.discard && existsSync(record.repoRoot) ? await pullRequestMerged(record.repoRoot, record.branch, this.options.gh) : false,
        worktreeExists,
        clean: worktreeExists ? await isClean(record.path) : true,
        hasSubmodules: worktreeExists ? await hasInitializedSubmodules(record.path) : false,
      },
      mode.auto,
    );
  }

  private async branchStillThere(record: WorktreeRecord): Promise<boolean> {
    return existsSync(record.repoRoot) && (await branchExists(record.repoRoot, record.branch));
  }

  private async cleanupOne(record: WorktreeRecord, mode: { auto: boolean; discard: boolean }): Promise<CleanupOutcome> {
    const decision = await this.decide(record, mode);
    if (decision.action === "skip") return { id: record.id, branch: record.branch, result: "skipped", reason: decision.reason };
    if (decision.action === "retain") {
      // A directory the person deleted by hand leaves a stale entry in git's
      // own list: forgotten here, that one entry only (the branch stays).
      if (!existsSync(record.path) && existsSync(record.repoRoot)) {
        const repo = await readRepo(record.repoRoot);
        if (!("error" in repo)) forgetMissingWorktree(repo.commonDir, record.path);
      }
      this.options.registry.put({ ...record, state: "retained", retained: { reason: decision.reason, at: this.now() } });
      return { id: record.id, branch: record.branch, result: "retained", reason: decision.reason };
    }
    // The decision is on disk before the first removal.
    const removing: WorktreeRecord = { ...record, state: "removing", removing: { force: decision.force, reason: decision.evidence } };
    this.options.registry.put(removing);
    this.options.crashPoint?.("afterRemoving");
    this.inFlight.add(record.id);
    try {
      return await this.finishRemoval(removing);
    } finally {
      this.inFlight.delete(record.id);
    }
  }

  /** Carries out a removal already decided: the worktree, then the branch,
   * then the record. Safe to run again after a crash at any step. */
  private async finishRemoval(record: WorktreeRecord): Promise<CleanupOutcome> {
    const force = record.removing?.force ?? false;
    const refuse = (reason: string): CleanupOutcome => {
      this.options.registry.put({ ...record, state: "retained", retained: { reason, at: this.now() } });
      return { id: record.id, branch: record.branch, result: "retained", reason };
    };
    if (!existsSync(record.repoRoot)) return refuse("its repository is not where it was");
    if (existsSync(record.path)) {
      const removed = await removeWorktree(record.repoRoot, record.path, force);
      if (!removed.ok && existsSync(record.path)) return refuse(removed.stderr.trim() || "git refused to remove it");
    } else {
      const repo = await readRepo(record.repoRoot);
      if (!("error" in repo)) forgetMissingWorktree(repo.commonDir, record.path);
    }
    this.options.crashPoint?.("afterWorktreeRemoved");
    if (await branchExists(record.repoRoot, record.branch)) {
      // `-D`, on the evidence already established (or the person's discard):
      // `-d` judges by the checkout's HEAD, not the base the branch started from.
      const deleted = await deleteBranch(record.repoRoot, record.branch);
      if (!deleted.ok) return refuse(deleted.stderr.trim() || "git refused to delete its branch");
    }
    this.options.registry.delete(record.id);
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
        if (!isOurs(record, this.options.root)) {
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
      const branchThere = existsSync(record.repoRoot) && (await branchExists(record.repoRoot, record.branch));
      infos.push({
        id: record.id,
        agentId: record.agentId,
        repoRoot: record.repoRoot,
        path: record.path,
        branch: record.branch,
        state: record.state,
        phase: this.options.agents.facts(record.agentId).busy ? "in_use" : "idle",
        ...(branchThere ? { commitsAhead: await commitsAhead(record.repoRoot, record.branch, record.base) } : {}),
        ...(exists ? { clean: await isClean(record.path) } : {}),
        integrated: record.declaredIntegrated !== undefined || (branchThere && (await isAncestorOfBase(record.repoRoot, record.branch, record.base))),
        ...(record.retained ? { retainedReason: record.retained.reason } : {}),
        ...(options.size && exists ? { sizeBytes: await directorySize(record.path) } : {}),
      });
    }
    return infos;
  }
}
