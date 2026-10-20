// What a room does when its agents call its tools: creating the principal,
// starting workers (`delegate`), recording their reports, passing messages
// down the tree, and describing the room. Each agent is an ordinary session
// whose turns run in the agent host; this file only decides who may do what
// and keeps each session's `room` record up to date.
//
// Every tool answers at once. Delegating creates the worker's session, queues
// its first turn and returns its id; the work itself runs on the worker's own
// turn, in the host. Handing reports back to the principal (the digest) is
// not done here: a report only lands in the worker's record and in the
// principal's outbox.
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { RoomBridge, RoomToolHost, RoomToolResult } from "../bridges/roomBridge.js";
import { checkDirectory } from "../fs/fsBrowse.js";
import { toHostPlatform } from "../runtimes/hostPlatform.js";
import type { Registry } from "../runtimes/registry.js";
import type { ModelCatalog, RoomAgentSetup, RoomToolSpec } from "../runtimes/types.js";
import { availableModes, isOfferedMode } from "./permissionModes.js";
import {
  ROOM_MAX_LIVE_AGENTS,
  ROOM_QUEUE_PER_AGENT_MAX,
  ROOM_QUEUE_PER_ROOM_MAX,
  ROOM_REPORT_SUMMARY_MAX,
  isDescendant,
  roomAgentState,
  takesRoomPlace,
  titleFromTask,
  type RoomAgentState,
  type RoomMembership,
} from "./room.js";
import {
  ROOM_MCP_SERVER_NAME,
  parseDelegateArgs,
  parseMessageAgentArgs,
  parseReportArgs,
  parseWorktreeCreateArgs,
  principalInstructions,
  roomToolsFor,
  workerInstructions,
} from "./roomTools.js";
import type { RoomWorktrees } from "./roomWorktrees.js";
import type { SessionStore } from "./sessionStore.js";
import type { SharedSession, TurnOutcome } from "./sharedSession.js";

/** The runtimes the agent host can run. */
export const HOST_RUNTIMES: readonly string[] = ["claude", "codex"];

export interface RoomSessions {
  getOrCreate(id: string): SharedSession;
  /** The live session, if it exists, without creating one. */
  peek(id: string): SharedSession | undefined;
  renameTitle(id: string, title: string): boolean;
}

/** Aliases the Claude CLI takes beyond the ids its own picker lists. */
const CLAUDE_MODEL_ALIAS = /^(default|best|haiku|sonnet|opus|opusplan)(\[1m\])?$|^claude-[a-z0-9.-]+$/;

export interface RoomManagerOptions {
  readonly store: SessionStore;
  readonly sessions: RoomSessions;
  readonly registry: Registry;
  readonly bridge: Pick<RoomBridge, "urlFor">;
  /** Runtimes installed on this machine that the agent host can run. */
  readonly runtimes: () => readonly string[];
  /** Whether the agent host is connected: without it no agent can start. */
  readonly hostConnected: () => boolean;
  readonly getModelCatalog?: (agentId: string) => ModelCatalog | undefined;
  /** Ends an agent's process in the agent host (its session is kept). */
  readonly stopInHost?: (agentId: string) => Promise<void>;
  /** The agents the host has that belong to a room (ids and room ids). */
  readonly listHostRoomAgents?: () => Promise<{ agentId: string; roomId?: string; owner?: string; state?: string; sessionId?: string }[]>;
  /** This relay's id on its agents in the host (see `roomOwnerOf`). */
  readonly owner?: string;
  /** Where the ids of deleted room agents wait until the host has let them
   * go (a host that was down when they were deleted). */
  readonly tombstonesFile?: string;
  /** Removes an agent from the host. */
  readonly removeFromHost?: (agentId: string) => Promise<void>;
  /** The worktrees agents create (`worktree_create`); without it the tool
   * answers that worktrees are not available. */
  readonly worktrees?: RoomWorktrees;
  readonly now?: () => number;
}

export interface CreateRoomInput {
  agentId?: unknown;
  model?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  cwd?: unknown;
  title?: unknown;
}

export type CreateRoomResult = { ok: true; roomId: string } | { ok: false; error: string };

export type StopAgentResult = { ok: true } | { ok: false; status: number; error: string };
export type ResumeAgentResult = StopAgentResult;

const ok = (text: string): RoomToolResult => ({ text, isError: false });
const fail = (text: string): RoomToolResult => ({ text, isError: true });

export class RoomManager implements RoomToolHost {
  private readonly now: () => number;
  /** Per worker, the queued message its current turn is delivering. */
  private readonly sending = new Map<string, { text: string; at: number; delivered: boolean }>();

  constructor(private readonly options: RoomManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  private get store(): SessionStore {
    return this.options.store;
  }

  private runtimes(): readonly string[] {
    return this.options.runtimes().filter((id) => HOST_RUNTIMES.includes(id) && this.options.registry.get(id) !== undefined);
  }

  /** Why a member may not run a turn now, or `undefined` when it may. */
  admit(sessionId: string): string | undefined {
    const room = this.store.getRoom(sessionId);
    if (!room) return "This agent is no longer part of a room.";
    if (this.store.getRoom(room.roomId)?.role !== "principal") return "This agent's room no longer exists.";
    if (room.stopped) return "This agent was stopped. Resume it from its room to give it more work.";
    return undefined;
  }

  /** The room wiring of a member, for its driver; none for one that may
   * not run (its driver then refuses to start it). */
  setupFor(sessionId: string): RoomAgentSetup | undefined {
    const room = this.store.getRoom(sessionId);
    if (!room || this.admit(sessionId) !== undefined) return undefined;
    return {
      role: room.role,
      instructions: room.role === "principal" ? principalInstructions(this.runtimes()) : workerInstructions(),
      tools: roomToolsFor(room.role),
      bridgeServerName: ROOM_MCP_SERVER_NAME,
      bridgeUrl: this.options.bridge.urlFor(sessionId),
    };
  }

  /** The tools a member may call right now: none once it was stopped or
   * removed, or when its room is gone. */
  toolsFor(sessionId: string): readonly RoomToolSpec[] | undefined {
    const room = this.store.getRoom(sessionId);
    if (!room || this.admit(sessionId) !== undefined) return undefined;
    return roomToolsFor(room.role);
  }

  callTool(sessionId: string, name: string, args: unknown): Promise<RoomToolResult> {
    const room = this.store.getRoom(sessionId);
    if (!room) return Promise.resolve(fail("This session is not an agent of a room."));
    switch (name) {
      case "delegate":
        return Promise.resolve(this.delegate(sessionId, room, args));
      case "report":
        return Promise.resolve(this.report(sessionId, room, args));
      case "message_agent":
        return Promise.resolve(this.messageAgent(sessionId, room, args));
      case "room_status":
        return Promise.resolve(this.roomStatus(sessionId, room));
      case "worktree_create":
        return this.worktreeCreate(sessionId, room, args);
      default:
        return Promise.resolve(fail(`Unknown tool "${name}".`));
    }
  }

  /** The person opens a room: its principal is a new session on the agent,
   * model and effort they picked. */
  createRoom(input: CreateRoomInput): CreateRoomResult {
    const agentId = input.agentId === undefined ? "claude" : input.agentId;
    if (typeof agentId !== "string" || !this.runtimes().includes(agentId)) {
      return { ok: false, error: `agentId must be one of: ${this.runtimes().join(", ")}` };
    }
    const def = this.options.registry.get(agentId)!;
    const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : undefined);
    if (input.model !== undefined && text(input.model, 200) === undefined) return { ok: false, error: "model must be a non-empty string" };
    if (input.effort !== undefined && text(input.effort, 64) === undefined) return { ok: false, error: "effort must be a non-empty string" };
    const modes = availableModes(def, toHostPlatform());
    if (input.permissionMode !== undefined && !(typeof input.permissionMode === "string" && isOfferedMode(modes, input.permissionMode))) {
      return { ok: false, error: `permissionMode must be one of: ${modes.map((mode) => mode.id).join(", ")}` };
    }
    let cwd: string | undefined;
    if (input.cwd !== undefined) {
      const checked = typeof input.cwd === "string" ? checkDirectory(input.cwd) : undefined;
      if (!checked?.ok) return { ok: false, error: "cwd must be an existing absolute directory" };
      cwd = checked.path;
    }
    const roomId = randomUUID();
    this.store.recordId(roomId);
    this.store.setAgentId(roomId, agentId);
    if (cwd) this.store.setCwd(roomId, cwd);
    const model = text(input.model, 200);
    if (model) this.store.setModel(roomId, agentId, model);
    const effort = text(input.effort, 64);
    if (effort) this.store.setEffort(roomId, agentId, effort);
    if (typeof input.permissionMode === "string") this.store.setPermissionMode(roomId, agentId, input.permissionMode);
    // Before the session exists: its driver is chosen from this record.
    this.store.setRoom(roomId, { roomId, role: "principal", createdBy: "user", task: "", undeliveredReports: [] });
    this.store.setTitle(roomId, text(input.title, 200) ?? "Room");
    this.options.sessions.getOrCreate(roomId);
    this.options.sessions.renameTitle(roomId, this.store.getTitle(roomId)!);
    return { ok: true, roomId };
  }

  /** The person stops one worker (only that card): its turn is
   * interrupted, nothing queued for it runs, its process is ended in the
   * host, and it is marked stopped, which frees its place under the room's
   * cap and closes its room tools. */
  async stopAgent(roomId: string, agentId: string): Promise<StopAgentResult> {
    const room = this.store.getRoom(agentId);
    if (this.store.getRoom(roomId)?.role !== "principal" || room?.roomId !== roomId) return { ok: false, status: 404, error: "no such agent in this room" };
    if (room.role !== "worker") return { ok: false, status: 400, error: "only a worker is stopped this way" };
    const { queuedMessages: _dropped, ...kept } = room;
    void _dropped;
    this.store.setRoom(agentId, { ...kept, stopped: room.stopped ?? { reason: "user", at: this.now() } });
    const session = this.options.sessions.getOrCreate(agentId);
    session.discardQueuedTurns();
    session.stopTurn();
    try {
      await this.options.stopInHost?.(agentId);
    } catch (error) {
      // Marked stopped regardless: its driver refuses to start it again.
      console.warn(`[relay] could not stop agent ${agentId} in the agent host: ${(error as Error).message}`);
    }
    return { ok: true };
  }

  /** The person gives a stopped worker its place back, if the room has one. */
  resumeAgent(roomId: string, agentId: string): ResumeAgentResult {
    const room = this.store.getRoom(agentId);
    if (this.store.getRoom(roomId)?.role !== "principal" || room?.roomId !== roomId) return { ok: false, status: 404, error: "no such agent in this room" };
    if (room.role !== "worker") return { ok: false, status: 400, error: "only a worker is resumed this way" };
    if (!room.stopped) return { ok: true };
    const { stopped: _stopped, ...rest } = room;
    void _stopped;
    this.store.setRoom(agentId, rest);
    return { ok: true };
  }

  private stateOf(id: string, room: RoomMembership): RoomAgentState {
    return roomAgentState(room, this.options.sessions.peek(id)?.isBusy() ?? false);
  }

  /** Agents of a room that take a place under its cap right now. */
  private placesTaken(roomId: string): number {
    return this.members(roomId).filter((member) => takesRoomPlace(this.stateOf(member.id, member.room))).length;
  }

  /** A turn of a member ended. A worker's turn that failed, or ended without
   * the agent reporting, gets a report from the relay, so the principal
   * hears about it and the worker stops holding a place. Then the next
   * queued message, if any, goes out. */
  onTurnSettled(sessionId: string, outcome: TurnOutcome): void {
    const sending = this.sending.get(sessionId);
    this.sending.delete(sessionId);
    const room = this.store.getRoom(sessionId);
    if (!room || room.role !== "worker" || room.stopped) return;
    if (sending && !sending.delivered) {
      // The queued message never reached the agent. With the host away it
      // stays queued, untouched, for when the host is back (the queues are
      // resumed on every connection); with the host there, it was refused,
      // and is dropped with the failure reported below.
      if (!this.options.hostConnected()) return;
      this.removeQueued(sessionId, sending);
    }
    if (!outcome.stopped) {
      // A followed turn began before this relay saw it: any report of the
      // agent's own may be this turn's.
      const reportedThisTurn = room.report !== undefined && !room.report.synthetic && (outcome.adopted === true || room.report.at >= outcome.startedAt);
      if (outcome.error !== undefined && reportedThisTurn && room.report) {
        // The agent reported, then its turn failed: its report stands (it
        // is what the agent said of its work), with the failure noted.
        const note = ` (The turn then failed: ${outcome.error})`;
        this.recordReport(sessionId, room, { ...room.report, summary: `${room.report.summary}${note}`.slice(0, ROOM_REPORT_SUMMARY_MAX + note.length) });
      } else if (outcome.error !== undefined) {
        this.recordReport(sessionId, room, { status: "failed", summary: `The agent's turn failed: ${outcome.error}`.slice(0, ROOM_REPORT_SUMMARY_MAX), artifacts: [], synthetic: true });
      } else if (!reportedThisTurn) {
        this.recordReport(sessionId, room, { status: "blocked", summary: "The agent ended its turn without reporting.", artifacts: [], synthetic: true });
      }
    }
    this.pump(sessionId);
    this.cleanWorktrees(sessionId);
  }

  /** What `RoomWorktrees` asks about an agent: whether it exists, has a turn
   * running, is done (reported, nothing queued), and where it works. */
  worktreeAgentFacts(agentId: string): { exists: boolean; busy: boolean; done: boolean; title?: string; cwd?: string; roomId?: string } {
    const room = this.store.getRoom(agentId);
    if (!room) return { exists: false, busy: false, done: true };
    const busy = this.options.sessions.peek(agentId)?.isBusy() ?? false;
    const state = roomAgentState(room, busy);
    return {
      exists: true,
      busy,
      done: room.role === "worker" && (state === "done" || state === "failed" || state === "blocked" || state === "stopped"),
      ...(this.store.getTitle(agentId) ? { title: this.store.getTitle(agentId)! } : {}),
      cwd: this.store.getCwdState(agentId).cwd,
      roomId: room.roomId,
    };
  }

  /** Removes the worktrees of a worker whose work is integrated, now that its
   * turn ended; the rest stay, with the reason. Never throws. */
  private cleanWorktrees(agentId: string): void {
    const worktrees = this.options.worktrees;
    if (!worktrees || this.store.getRoom(agentId)?.role !== "worker") return;
    worktrees.cleanupAgent(agentId, { auto: true }).catch((error: unknown) => console.warn(`[relay] worktree cleanup of agent ${agentId} failed: ${(error as Error).message}`));
  }

  private async worktreeCreate(callerId: string, caller: RoomMembership, rawArgs: unknown): Promise<RoomToolResult> {
    if (caller.role !== "worker") return fail("Only an agent started in the room creates worktrees; the principal does not change files.");
    const worktrees = this.options.worktrees;
    if (!worktrees) return fail("Worktrees are not available on this relay; work in your working folder.");
    const parsed = parseWorktreeCreateArgs(rawArgs);
    if (!parsed.ok) return fail(parsed.error);
    const created = await worktrees.create(caller.roomId, callerId, parsed.value.repo);
    if (!created.ok) return fail(created.error);
    const warnings = created.warnings.length > 0 ? ` Note: ${created.warnings.join("; ")}.` : "";
    return ok(`Worktree ready on branch ${created.branch} (from ${created.base}). Work and commit only inside ${created.workdir}.${warnings}`);
  }

  /** Hands the next queued message of an idle worker to its session. It
   * leaves the queue (on disk) only once the host has taken it, so neither
   * a host that is away nor a relay restart in between loses it; with the
   * host away nothing is tried at all. */
  private pump(sessionId: string): void {
    const room = this.store.getRoom(sessionId);
    if (!room || room.role !== "worker" || this.admit(sessionId) !== undefined) return;
    if (!this.options.hostConnected() || this.sending.has(sessionId)) return;
    const session = this.options.sessions.getOrCreate(sessionId);
    if (session.isBusy()) return;
    const next = room.queuedMessages?.[0];
    if (!next) return;
    const sending = { text: next.text, at: next.at, delivered: false };
    this.sending.set(sessionId, sending);
    session.submitAgentTurn(next.text, {
      onDelivered: () => {
        sending.delivered = true;
        this.removeQueued(sessionId, sending);
      },
    });
  }

  /** Drops `message` from the head of a worker's queue, if it is still there. */
  private removeQueued(sessionId: string, message: { text: string; at: number }): void {
    const room = this.store.getRoom(sessionId);
    const [head, ...rest] = room?.queuedMessages ?? [];
    if (!room || !head || head.text !== message.text || head.at !== message.at) return;
    const { queuedMessages: _old, ...kept } = room;
    void _old;
    this.store.setRoom(sessionId, rest.length > 0 ? { ...kept, queuedMessages: rest } : kept);
  }

  /** A room member's session was deleted: its agent is to leave the host,
   * now or on a later connection. */
  onMemberDeleted(sessionId: string): void {
    const tombstones = this.readTombstones();
    if (tombstones.includes(sessionId)) return;
    this.writeTombstones([...tombstones, sessionId]);
  }

  private readTombstones(): string[] {
    if (!this.options.tombstonesFile) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.options.tombstonesFile, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  private writeTombstones(ids: readonly string[]): void {
    if (!this.options.tombstonesFile) return;
    const tmp = `${this.options.tombstonesFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(ids), { mode: 0o600 });
    renameSync(tmp, this.options.tombstonesFile);
  }

  /**
   * Removes from the host the room agents this relay let go: those it
   * deleted (tombstones) and those it has no record of at all. Only agents
   * this relay created (their `owner` is its own id) — another relay on the
   * same host is left alone — and never when the sessions file did not load
   * from a valid file (an unreadable file would make every agent look
   * unknown); after starting over from an unreadable file, only tombstoned
   * ones until the marker is removed. A missing file of a new profile is a
   * valid, empty store. A record whose room this release cannot read still
   * counts as known. Agents created before owners existed carry none and
   * are never touched. Returns the ids removed.
   */
  async reconcileHost(): Promise<string[]> {
    if (!this.options.listHostRoomAgents || !this.options.removeFromHost) return [];
    const agents = await this.options.listHostRoomAgents();
    this.followTurnsInFlight(agents);
    const owner = this.options.owner;
    if (!owner || !this.store.loadedOk) return [];
    const tombstones = new Set(this.readTombstones());
    const removed: string[] = [];
    for (const agent of agents) {
      if (agent.roomId === undefined || agent.owner !== owner) continue;
      // A missing record only counts once the store's records are trusted
      // as complete (not after starting over from an unreadable file).
      const deleted = tombstones.has(agent.agentId);
      if (!deleted && (this.store.has(agent.agentId) || this.store.recoveredFromCorrupt)) continue;
      try {
        await this.options.removeFromHost(agent.agentId);
        removed.push(agent.agentId);
      } catch (error) {
        console.warn(`[relay] could not remove agent ${agent.agentId} from the agent host: ${(error as Error).message}`);
      }
    }
    // A tombstone is done once its agent is gone from the host. Applied to
    // the file as it is now, not to the snapshot read above: a deletion
    // recorded during the awaits keeps its tombstone.
    const present = new Set(agents.map((agent) => agent.agentId).filter((id) => !removed.includes(id)));
    const done = new Set([...tombstones].filter((id) => !present.has(id)));
    if (done.size > 0) {
      const current = this.readTombstones();
      this.writeTombstones(current.filter((id) => !done.has(id)));
    }
    if (removed.length > 0) console.log(`[relay] removed ${removed.length} agent(s) the rooms no longer have from the agent host`);
    return removed;
  }

  /** Picks up the turns room agents were running in the host while this
   * relay was away, so their clients see them go on and they count as at
   * work. */
  followTurnsInFlight(agents: readonly { agentId: string; state?: string; sessionId?: string }[]): void {
    for (const agent of agents) {
      if (agent.state !== "working" && agent.state !== "starting") continue;
      if (!this.store.getRoom(agent.agentId)) continue;
      this.options.sessions.getOrCreate(agent.agentId).followTurnInFlight(agent.sessionId);
    }
  }

  /** Delivers what was queued before a relay restart. */
  resumeQueues(): void {
    for (const id of this.store.listIds()) if ((this.store.getRoom(id)?.queuedMessages?.length ?? 0) > 0) this.pump(id);
  }

  private recordReport(workerId: string, worker: RoomMembership, report: Omit<NonNullable<RoomMembership["report"]>, "at">): void {
    this.store.setRoom(workerId, { ...worker, report: { ...report, at: this.now() } });
    const principal = this.store.getRoom(worker.roomId);
    if (principal?.role === "principal") {
      const outbox = principal.undeliveredReports ?? [];
      if (!outbox.includes(workerId)) this.store.setRoom(worker.roomId, { ...principal, undeliveredReports: [...outbox, workerId] });
    }
  }

  /** A model the runtime will take: the catalog's own ids, and for Claude
   * its aliases (the CLI takes more than its picker lists). Unknown
   * catalog: anything goes, the CLI is the judge. */
  private checkModel(runtime: string, model: string): string | undefined {
    const catalog = this.options.getModelCatalog?.(runtime);
    if (!catalog || catalog.options.some((option) => option.id === model)) return undefined;
    if (runtime === "claude" && CLAUDE_MODEL_ALIAS.test(model)) return undefined;
    return `Model "${model}" is not one ${runtime} offers here. Use one of: ${catalog.options.map((option) => option.id).join(", ")}${runtime === "claude" ? " (or haiku, sonnet, opus)" : ""}.`;
  }

  // ------------------------------------------------------------ tools

  private members(roomId: string): { id: string; room: RoomMembership }[] {
    return this.store.listRoomMembers(roomId);
  }

  private delegate(callerId: string, caller: RoomMembership, rawArgs: unknown): RoomToolResult {
    if (caller.role !== "principal") return fail("Only the room's principal can delegate.");
    const parsed = parseDelegateArgs(rawArgs);
    if (!parsed.ok) return fail(parsed.error);
    const args = parsed.value;
    const runtimes = this.runtimes();
    if (!runtimes.includes(args.runtime)) return fail(`Unknown runtime "${args.runtime}". Use one of: ${runtimes.join(", ")}.`);
    const roomId = caller.roomId;
    const members = this.members(roomId);
    const parentId = args.parentId ?? callerId;
    const parent = members.find((member) => member.id === parentId);
    if (!parent) return fail(`There is no agent "${parentId}" in this room; parentId must be one of its agents.`);
    if (parent.room.stopped) return fail(`Agent "${parentId}" was stopped; pick another parent.`);
    const live = this.placesTaken(roomId);
    if (live >= ROOM_MAX_LIVE_AGENTS) {
      return fail(`room_cap_reached: this room already has ${live} agents at work, the limit is ${ROOM_MAX_LIVE_AGENTS}. Wait for one to report, or ask the person to stop one, before delegating more.`);
    }
    const modelProblem = this.checkModel(args.runtime, args.model);
    if (modelProblem) return fail(modelProblem);
    if (!this.options.hostConnected()) return fail("The agent host is not running, so no agent can start now. Tell the person; nothing was started.");
    const def = this.options.registry.get(args.runtime)!;
    const option = this.options.getModelCatalog?.(args.runtime)?.options.find((candidate) => candidate.id === args.model);
    if (args.effort !== undefined && option?.efforts && !option.efforts.some((effort) => effort.id === args.effort)) {
      return fail(`Model ${args.model} takes effort ${option.efforts.map((effort) => effort.id).join(", ")}; leave effort out to use its default.`);
    }

    // The worker runs in the principal's folder and inherits its permission
    // mode, when the worker's runtime has that mode.
    const principalAgent = this.store.getAgentId(roomId);
    const principalDef = this.options.registry.get(principalAgent);
    const inherited = this.store.getPermissionMode(roomId, principalAgent, principalDef?.permissions.defaultModeId ?? def.permissions.defaultModeId);
    const mode = isOfferedMode(availableModes(def, toHostPlatform()), inherited) ? inherited : def.permissions.defaultModeId;

    const workerId = randomUUID();
    this.store.recordId(workerId);
    this.store.setAgentId(workerId, args.runtime);
    this.store.setCwd(workerId, this.store.getCwdState(roomId).cwd);
    this.store.setModel(workerId, args.runtime, args.model);
    if (args.effort) this.store.setEffort(workerId, args.runtime, args.effort);
    this.store.setPermissionMode(workerId, args.runtime, mode);
    this.store.setRoom(workerId, {
      roomId,
      role: "worker",
      parentId,
      createdBy: "agent",
      task: args.task,
      ...(args.area ? { area: args.area } : {}),
      // Persisted until it is delivered: a relay restart loses no task.
      queuedMessages: [{ text: args.task, at: this.now() }],
    });
    // Titled before its first turn, so no title is generated for it.
    this.store.setTitle(workerId, titleFromTask(args.task));
    this.pump(workerId);
    return ok(JSON.stringify({ agentId: workerId }));
  }

  private report(callerId: string, caller: RoomMembership, rawArgs: unknown): RoomToolResult {
    if (caller.role !== "worker") return fail("Only an agent started in the room reports; the principal answers the person directly.");
    const parsed = parseReportArgs(rawArgs);
    if (!parsed.ok) return fail(parsed.error);
    const { integrated, ...report } = parsed.value;
    this.recordReport(callerId, caller, report);
    if (integrated) this.options.worktrees?.declareIntegratedFor(callerId, "agent");
    return ok("Report recorded. End your turn now.");
  }

  private messageAgent(callerId: string, caller: RoomMembership, rawArgs: unknown): RoomToolResult {
    if (caller.role !== "principal") return fail("Only the room's principal can message other agents.");
    const parsed = parseMessageAgentArgs(rawArgs);
    if (!parsed.ok) return fail(parsed.error);
    const { agentId, text } = parsed.value;
    const target = this.store.getRoom(agentId);
    const parentOf = (id: string): string | undefined => this.store.getRoom(id)?.parentId;
    if (!target || target.roomId !== caller.roomId || !isDescendant(agentId, callerId, parentOf)) {
      return fail(`There is no agent "${agentId}" below you in this room.`);
    }
    if (target.stopped) return fail(`Agent "${agentId}" was stopped; it takes no messages.`);
    const queue = target.queuedMessages ?? [];
    if (queue.length >= ROOM_QUEUE_PER_AGENT_MAX) return fail(`Agent "${agentId}" already has ${queue.length} messages waiting (the limit); wait for it to get to them.`);
    const roomQueued = this.members(caller.roomId).reduce((sum, member) => sum + (member.room.queuedMessages?.length ?? 0), 0);
    if (roomQueued >= ROOM_QUEUE_PER_ROOM_MAX) return fail(`This room already has ${roomQueued} messages waiting (the limit); wait for its agents to get to them.`);
    // An agent at rest takes a place again once it has work: refused now if
    // there is none, rather than lost later.
    if (!takesRoomPlace(this.stateOf(agentId, target)) && this.placesTaken(caller.roomId) >= ROOM_MAX_LIVE_AGENTS) {
      return fail(`room_cap_reached: this room already has ${ROOM_MAX_LIVE_AGENTS} agents at work; agent "${agentId}" cannot take this message until one is done.`);
    }
    this.store.setRoom(agentId, { ...target, queuedMessages: [...queue, { text, at: this.now() }] });
    this.pump(agentId);
    if (!this.options.hostConnected()) {
      return ok(`Message queued for ${this.store.getTitle(agentId) ?? agentId}; the agent host is not running, so it is delivered once it is back.`);
    }
    return ok(`Message queued for ${this.store.getTitle(agentId) ?? agentId}; it is delivered as its next turn.`);
  }

  private roomStatus(callerId: string, caller: RoomMembership): RoomToolResult {
    const agents = this.members(caller.roomId)
      .filter((member) => member.id !== callerId && member.room.role === "worker")
      .map(({ id, room }) => {
        const runtime = this.store.getAgentId(id);
        const state = this.stateOf(id, room);
        return {
          agentId: id,
          title: this.store.getTitle(id),
          runtime,
          model: this.store.getModel(id, runtime) ?? null,
          parentId: room.parentId,
          ...(room.area ? { area: room.area } : {}),
          state,
          ...(room.queuedMessages?.length ? { queuedMessages: room.queuedMessages.length } : {}),
          ...(room.report
            ? { report: { status: room.report.status, summary: room.report.summary, artifacts: room.report.artifacts, ...(room.report.synthetic ? { fromRelay: true } : {}) } }
            : {}),
        };
      });
    return ok(JSON.stringify({ agents, liveLimit: ROOM_MAX_LIVE_AGENTS }));
  }
}
