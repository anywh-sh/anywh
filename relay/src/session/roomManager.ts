// What a room does when its agents call its tools: creating the principal,
// starting workers (`delegate`), recording their reports, passing messages
// down the tree, and describing the room. Each agent is an ordinary session
// whose turns run in the agent host; this file only decides who may do what
// and keeps each session's `room` record up to date.
//
// Every tool answers at once. Delegating creates the worker's session, queues
// its first turn and returns its id; the work itself runs on the worker's own
// turn, in the host. A report lands in the worker's record and in the outbox
// of the agent that reads it, which gets it as one digest turn per round.
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { RoomBridge, RoomToolHost, RoomToolResult } from "../bridges/roomBridge.js";
import { checkDirectory } from "../fs/fsBrowse.js";
import { toHostPlatform } from "../runtimes/hostPlatform.js";
import type { Registry } from "../runtimes/registry.js";
import type { ModelCatalog, RoomAgentSetup, RoomToolSpec } from "../runtimes/types.js";
import { availableModes, isOfferedMode } from "./permissionModes.js";
import {
  ROOM_CONNECTORS_MAX,
  ROOM_MAX_LIVE_AGENTS,
  isConnectorServer,
  ROOM_QUEUE_PER_AGENT_MAX,
  ROOM_TASK_MAX,
  ROOM_QUEUE_PER_ROOM_MAX,
  ROOM_REPORT_SUMMARY_MAX,
  isDescendant,
  liveAncestorId,
  roomAgentState,
  takesRoomPlace,
  titleFromTask,
  type RoomAgentState,
  type RoomMembership,
} from "./room.js";
import { roomPromptsDraft, type PushNotificationDraft, type RoomPromptEntry } from "../push/events.js";
import { summarizeRoom, type NeedsYou, type RoomAgentView, type RoomSnapshot } from "./roomState.js";
import { buildRoomDigest, isUrgent, type DigestEntry } from "./roomDigest.js";
import {
  ROOM_MCP_SERVER_NAME,
  parseDelegateArgs,
  type DelegateArgs,
  parseMessageAgentArgs,
  parseReportArgs,
  parseWorktreeCreateArgs,
  principalInstructions,
  APPROVE_TOOL,
  roomToolsFor,
  workerInstructions,
} from "./roomTools.js";
import type { RoomWorktrees, WorktreeInfo } from "./roomWorktrees.js";
import { buildNotice } from "./roomContextIndex.js";
import type { RoomContextStore } from "./roomContextStore.js";
import type { SessionStore } from "./sessionStore.js";
import type { SharedSession, TurnOutcome } from "./sharedSession.js";

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

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
  /** How long a wake-up waits for more reports before the digest goes out:
   * agents that finish together share one turn. Default 2 s. */
  readonly digestWindowMs?: number;
  /** Deletes an agent's session (and, with it, the agents below it and
   * their agents in the host). */
  readonly deleteAgent?: (agentId: string) => boolean;
  /** How long a removed agent can still be brought back before it is
   * deleted for good. Default 15 s. */
  readonly removeUndoMs?: number;
  /** Agents that were just deleted for good after a removal (the root of the
   * removed subtree and everything below it). */
  readonly onPurged?: (agentIds: readonly string[]) => void;
  /** Tells the person's devices that agents of a room wait for them (one
   * call per round, about the room's principal session). */
  readonly notifyPerson?: (event: { roomId: string; draft: PushNotificationDraft; watched: boolean }) => void;
  /** How long the questions of several agents are gathered into one
   * notification. Default 1.5 s. */
  readonly promptWindowMs?: number;
  /** The rooms' context folders. Without it a room has no shared context. */
  readonly context?: RoomContextStore;
  /** How long agents of one model wait behind the first of them to be
   * launched (see `pump`). Default 6 s. */
  readonly warmUpMs?: number;
  /** Runs `fn` after `ms`; returns how to cancel it. Replaceable so a test
   * steps time by hand. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

/** What the model's cache needs to be written once before siblings can read
 * it: measured at about 6 s for the first response to start. */
export const ROOM_WARM_UP_MS = 6000;

export interface CreateRoomInput {
  agentId?: unknown;
  model?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  cwd?: unknown;
  title?: unknown;
  firstMessage?: unknown;
}

export type CreateRoomResult = { ok: true; roomId: string } | { ok: false; error: string };

export type StopAgentResult = { ok: true } | { ok: false; status: number; error: string };
export type ResumeAgentResult = StopAgentResult;
export type RemoveAgentResult =
  | { ok: true; removed: string[]; undoMs: number }
  | { ok: false; status: number; error: string; /** Set when the removal waits for the person to confirm discarding. */ needsDiscard?: true; worktrees?: WorktreeInfo[] };
export type RestoreAgentResult = { ok: true; restored: string[] } | { ok: false; status: number; error: string };

const ok = (text: string): RoomToolResult => ({ text, isError: false });
const fail = (text: string): RoomToolResult => ({ text, isError: true });

export class RoomManager implements RoomToolHost {
  private readonly now: () => number;
  /** Per worker, the queued message its current turn is delivering. */
  private readonly sending = new Map<string, { text: string; at: number; delivered: boolean }>();
  /** Per agent, the coalescing timer of a digest about to go out. */
  private readonly digestTimers = new Map<string, NodeJS.Timeout>();
  /** Per agent, the digest turn queued or running for it: at most one at a
   * time, so a round of reports is one turn however they arrive. */
  private readonly digests = new Map<string, { delivered: boolean }>();
  /** Agents whose last digest turn ended (failed, or was stopped) before the
   * host took it: not tried again until a new report arrives, so a turn that
   * cannot start does not loop. */
  private readonly digestFailed = new Set<string>();
  /** Per removed root, the timer that deletes its subtree once the undo
   * window is over. */
  private readonly purgeTimers = new Map<string, NodeJS.Timeout>();
  /** Worktree ids to discard when a removed subtree (by its root) is deleted
   * for good; set by a removal the person confirmed. */
  private readonly discardOnPurge = new Map<string, string[]>();
  /** Per room, the gathering of questions into one notification, and the
   * prompts the person has already been told about. */
  private readonly promptRounds = new Map<string, { timer: NodeJS.Timeout; watched: boolean }>();
  private readonly notifiedPrompts = new Map<string, Set<string>>();
  /** Per runtime and model, the agent launched first and those waiting
   * behind it. Launching a batch cold would make every one of them write the
   * whole prompt to the cache; behind the first, the rest read it. */
  private readonly warming = new Map<string, { leader: string; waiting: Set<string>; cancel?: () => void }>();
  private readonly warmingKeyOf = new Map<string, string>();
  /** Agents let go when their leader's window closed: they start, none of them
   * waits behind another (the cache is warm). */
  private readonly released = new Set<string>();

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
    const context = this.options.context && { dir: this.options.context.dirFor(room.roomId), index: this.options.context.indexNow(room.roomId) };
    // Its prompt, index included, is built now and frozen by the CLI at its
    // first request: what arrives after this is told in a message.
    if (room.contextSeenAt === undefined && context) this.store.setRoom(sessionId, { ...room, contextSeenAt: this.now() });
    return {
      role: room.role,
      instructions: room.role === "principal" ? principalInstructions(this.runtimes(), context) : workerInstructions(context),
      tools: roomToolsFor(room.role),
      ...(context ? { addDirs: [context.dir] } : {}),
      bridgeServerName: ROOM_MCP_SERVER_NAME,
      bridgeUrl: this.options.bridge.urlFor(sessionId),
    };
  }

  /** The tools a member may call right now: none once it was stopped or
   * removed, or when its room is gone. */
  toolsFor(sessionId: string): readonly RoomToolSpec[] | undefined {
    const room = this.store.getRoom(sessionId);
    if (!room || this.admit(sessionId) !== undefined) return undefined;
    // A worker's CLI also asks the relay about tool calls that need approval.
    return room.role === "worker" ? [...roomToolsFor(room.role), APPROVE_TOOL] : roomToolsFor(room.role);
  }

  /** A note for the model alone on an agent's next turn when items joined the
   * room's context after it was born, and the commit that marks them told
   * (called once the turn went through). */
  turnNote(sessionId: string): { text: string; commit: () => void } | undefined {
    const room = this.store.getRoom(sessionId);
    const context = this.options.context;
    if (!room || !context || room.contextSeenAt === undefined) return undefined;
    const fresh = context.itemsAfter(room.roomId, room.contextSeenAt);
    if (fresh.length === 0) return undefined;
    const seenAt = fresh[fresh.length - 1].at;
    return {
      text: buildNotice(fresh),
      commit: () => {
        const current = this.store.getRoom(sessionId);
        if (current && (current.contextSeenAt ?? 0) < seenAt) this.store.setRoom(sessionId, { ...current, contextSeenAt: seenAt });
      },
    };
  }

  async callTool(sessionId: string, name: string, args: unknown): Promise<RoomToolResult> {
    const room = this.store.getRoom(sessionId);
    if (!room) return fail("This session is not an agent of a room.");
    switch (name) {
      case "delegate":
        // What agents wrote into the folder since the last look is in the
        // index the new worker is born with.
        await this.options.context?.sync(room.roomId).catch(() => undefined);
        return this.delegate(sessionId, room, args);
      case "report": {
        const result = this.report(sessionId, room, args);
        if (!result.isError) await this.adoptResultFiles(sessionId, room, args);
        return result;
      }
      case "message_agent":
        return this.messageAgent(sessionId, room, args);
      case "room_status":
        return Promise.resolve(this.roomStatus(sessionId, room));
      case "approve":
        return this.approve(sessionId, room, args);
      case "worktree_create":
        return this.worktreeCreate(sessionId, room, args);
      default:
        return fail(`Unknown tool "${name}".`);
    }
  }

  /** A report may name files the agent wrote into the room's folder: they
   * join the index, credited to it. */
  private async adoptResultFiles(sessionId: string, room: RoomMembership, args: unknown): Promise<void> {
    const parsed = parseReportArgs(args);
    if (!this.options.context || !parsed.ok) return;
    try {
      await this.options.context.sync(room.roomId, { author: this.store.getTitle(sessionId) ?? "agent", artifacts: parsed.value.artifacts });
    } catch (error) {
      console.warn(`[relay] could not index the room's context after a report: ${(error as Error).message}`);
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
    if (input.firstMessage !== undefined && !(typeof input.firstMessage === "string" && input.firstMessage.trim() !== "" && input.firstMessage.length <= ROOM_TASK_MAX)) {
      return { ok: false, error: "firstMessage must be a non-empty string" };
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
    // Delivered to the principal's own session, as if typed there, so the
    // client needs no second socket to send it.
    if (typeof input.firstMessage === "string") this.options.sessions.getOrCreate(roomId).submitAgentTurn(input.firstMessage);
    return { ok: true, roomId };
  }

  /** The person starts a worker from the canvas: the same path as the
   * principal's `delegate`, recorded as created by the person. The model
   * defaults to the principal's when the runtime is the same. */
  launchByPerson(roomId: string, input: unknown): { ok: true; agentId: string } | { ok: false; status: number; error: string } {
    const principal = this.store.getRoom(roomId);
    if (principal?.role !== "principal") return { ok: false, status: 404, error: "room not found" };
    const raw = typeof input === "object" && input !== null ? { ...(input as Record<string, unknown>) } : {};
    const principalRuntime = this.store.getAgentId(roomId);
    const runtime = raw.agentId === undefined ? principalRuntime : raw.agentId;
    delete raw.agentId;
    if (typeof runtime !== "string") return { ok: false, status: 400, error: "agentId must be a string" };
    let model = raw.model;
    if (model === undefined && runtime.toLowerCase() === principalRuntime) model = this.store.getModel(roomId, principalRuntime);
    if (model === undefined) return { ok: false, status: 400, error: "model is required when the agent differs from the room's principal" };
    const parsed = parseDelegateArgs({ ...raw, runtime, model });
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    const result = this.launchWorker(roomId, roomId, parsed.value, "user");
    if (result.isError) return { ok: false, status: result.text.startsWith("room_cap_reached") ? 409 : 400, error: result.text };
    return { ok: true, agentId: (JSON.parse(result.text) as { agentId: string }).agentId };
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
    this.endWarmUp(agentId);
    const session = this.options.sessions.getOrCreate(agentId);
    session.discardQueuedTurns();
    session.stopTurn();
    this.handOffOutbox(agentId);
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
    if (room.stopped.reason === "removed") return { ok: false, status: 404, error: "no such agent in this room" };
    const { stopped: _stopped, ...rest } = room;
    void _stopped;
    this.store.setRoom(agentId, rest);
    return { ok: true };
  }

  /** A worker asked the person something. The person hears about it from
   * the room, once for the agents that asked together, never from each
   * worker. */
  workerPrompted(workerId: string, watched: boolean): void {
    const room = this.store.getRoom(workerId);
    if (room?.role !== "worker" || room.stopped || !this.options.notifyPerson) return;
    const round = this.promptRounds.get(room.roomId);
    if (round) {
      round.watched = round.watched || watched;
      return;
    }
    const timer = setTimeout(() => {
      const gathered = this.promptRounds.get(room.roomId);
      this.promptRounds.delete(room.roomId);
      this.notifyPrompts(room.roomId, gathered?.watched ?? false);
    }, this.options.promptWindowMs ?? 1500);
    timer.unref();
    this.promptRounds.set(room.roomId, { timer, watched });
  }

  /** Tells the person about the prompts of a room it has not told them about. */
  private notifyPrompts(roomId: string, watched: boolean): void {
    if (this.store.getRoom(roomId)?.role !== "principal") {
      this.notifiedPrompts.delete(roomId);
      return;
    }
    const known = this.notifiedPrompts.get(roomId) ?? new Set<string>();
    const current = new Set<string>();
    const entries: RoomPromptEntry[] = [];
    for (const { id, room } of this.members(roomId)) {
      if (room.role !== "worker" || room.stopped) continue;
      const needs = this.needsYou(id);
      for (const need of needs) current.add(need.promptId);
      // One entry per agent, whatever it asks.
      const fresh = needs.find((need) => !known.has(need.promptId));
      if (!fresh) continue;
      const choice = fresh.kind === "choice" ? this.store.getPendingChoice(id) : undefined;
      entries.push({ kind: fresh.kind, agentTitle: this.store.getTitle(id), ...(choice?.questions[0] ? { firstQuestion: choice.questions[0].question } : {}) });
    }
    // What was answered stops counting, so a later prompt is told again.
    this.notifiedPrompts.set(roomId, current);
    if (entries.length === 0) return;
    const looking = this.options.sessions.peek(roomId)?.isAnyoneLooking() ?? false;
    this.options.notifyPerson?.({ roomId, draft: roomPromptsDraft({ roomTitle: this.store.getTitle(roomId), entries }), watched: watched || looking });
  }

  /** A member's turn began: its clock restarts (a digest the relay hands a
   * principal is not work of its own, so it does not). */
  noteTurnStarted(id: string, startedAt: number, synthetic?: string): void {
    const room = this.store.getRoom(id);
    if (!room || synthetic === "room_digest" || room.startedAt === startedAt) return;
    this.store.setRoom(id, { ...room, startedAt });
  }

  /** A member called a tool of MCP server `server`: remembered as a
   * connector it used, unless the server is one of the relay's own bridges. */
  noteConnector(id: string, server: string): void {
    const room = this.store.getRoom(id);
    if (!room || !isConnectorServer(server)) return;
    const known = room.connectors ?? [];
    if (known.includes(server) || known.length >= ROOM_CONNECTORS_MAX) return;
    this.store.setRoom(id, { ...room, connectors: [...known, server] });
  }

  /** What the person is being asked by `id`, from what is persisted. */
  private needsYou(id: string): NeedsYou[] {
    const out: NeedsYou[] = [];
    // Nobody can usefully answer an agent that was stopped or removed.
    if (this.store.getRoom(id)?.stopped) return out;
    const choice = this.store.getPendingChoice(id);
    if (choice) out.push({ kind: "choice", promptId: choice.promptId, ...(choice.askedAt !== undefined ? { askedAt: choice.askedAt } : {}), count: choice.questions.length });
    const approval = this.store.getPendingApproval(id);
    if (approval) out.push({ kind: "approval", promptId: approval.promptId, ...(approval.askedAt !== undefined ? { askedAt: approval.askedAt } : {}), count: approval.calls.length });
    return out;
  }

  /** One agent as the room's channel shows it. */
  private agentView(id: string, room: RoomMembership): RoomAgentView {
    const runtime = this.store.getAgentId(id);
    const needsYou = this.needsYou(id);
    return {
      agentId: id,
      role: room.role,
      ...(room.parentId !== undefined ? { parentId: room.parentId } : {}),
      title: this.store.getTitle(id),
      runtime,
      model: this.store.getModel(id, runtime) ?? null,
      ...(room.area ? { area: room.area } : {}),
      createdBy: room.createdBy,
      state: this.stateOf(id, room),
      queuedMessages: room.queuedMessages?.length ?? 0,
      ...(room.report
        ? { report: { status: room.report.status, summary: room.report.summary, artifacts: room.report.artifacts, at: room.report.at, ...(room.report.synthetic ? { fromRelay: true } : {}) } }
        : {}),
      ...(room.startedAt !== undefined ? { startedAt: room.startedAt } : {}),
      connectors: room.connectors ?? [],
      needsYou,
      subtasksRunning: this.options.sessions.peek(id)?.listSubtasks().filter((task) => task.status === "running").length ?? 0,
    };
  }

  /** The whole room's state (every agent but the removed ones, the
   * principal first) and its totals, or `undefined` when there is no such
   * room. */
  snapshot(roomId: string): RoomSnapshot | undefined {
    if (this.store.getRoom(roomId)?.role !== "principal") return undefined;
    const agents = this.members(roomId)
      .filter(({ room }) => room.stopped?.reason !== "removed")
      .sort((a, b) => (a.room.role === b.room.role ? 0 : a.room.role === "principal" ? -1 : 1))
      .map(({ id, room }) => this.agentView(id, room));
    return { roomId, agents, summary: summarizeRoom(agents) };
  }

  /** `agentId` and every agent below it, in the room. */
  private subtreeOf(roomId: string, agentId: string): string[] {
    const parentOf = (id: string): string | undefined => this.store.getRoom(id)?.parentId;
    return this.members(roomId)
      .filter((member) => member.id === agentId || isDescendant(member.id, agentId, parentOf))
      .map((member) => member.id);
  }

  /** The person removes an agent: it and every agent below it are stopped
   * and hidden at once, and deleted for good once the undo window is over
   * (`restoreAgent` within it brings them back). */
  async removeAgent(roomId: string, agentId: string, options: { discard?: boolean } = {}): Promise<RemoveAgentResult> {
    const room = this.store.getRoom(agentId);
    if (this.store.getRoom(roomId)?.role !== "principal" || room?.roomId !== roomId) return { ok: false, status: 404, error: "no such agent in this room" };
    if (room.role !== "worker") return { ok: false, status: 400, error: "only a worker is removed this way; delete the room to remove its principal" };
    if (room.stopped?.reason === "removed") return { ok: false, status: 404, error: "no such agent in this room" };
    const ids = this.subtreeOf(roomId, agentId).filter((id) => this.store.getRoom(id)?.stopped?.reason !== "removed");
    // Work that is not integrated anywhere else is only dropped on the
    // person's say-so: without it nothing is removed.
    const unintegrated = (await this.worktreesOf(roomId, { size: true })).filter((tree) => ids.includes(tree.agentId) && !tree.integrated);
    if (unintegrated.length > 0 && options.discard !== true) {
      return { ok: false, status: 409, error: "these agents have work in worktrees that is not integrated; remove with discard to drop it", needsDiscard: true, worktrees: unintegrated };
    }
    if (unintegrated.length > 0) this.discardOnPurge.set(agentId, unintegrated.map((tree) => tree.id));
    else this.discardOnPurge.delete(agentId);
    const at = this.now();
    for (const id of ids) {
      const member = this.store.getRoom(id)!;
      const { queuedMessages: _dropped, ...kept } = member;
      void _dropped;
      this.store.setRoom(id, { ...kept, stopped: { reason: "removed", at } });
    }
    // The agents are stopped first and the outboxes handed up after, so no
    // report goes to an agent that is itself going away.
    for (const id of ids) {
      const session = this.options.sessions.getOrCreate(id);
      session.discardQueuedTurns();
      session.stopTurn();
      this.sending.delete(id);
    }
    for (const id of ids) this.handOffOutbox(id);
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.options.stopInHost?.(id);
        } catch (error) {
          console.warn(`[relay] could not stop agent ${id} in the agent host: ${(error as Error).message}`);
        }
      }),
    );
    // Restored (or removed again) while the host was stopping them: that
    // call's own window and timer are the ones that count.
    if (this.store.getRoom(agentId)?.stopped?.at !== at) return { ok: true, removed: ids, undoMs: this.undoMs() };
    // The window starts when the agents are really gone from the host, not
    // when the person asked: a slow stop must not use it up.
    const from = this.now();
    for (const id of ids) {
      const member = this.store.getRoom(id);
      if (member?.stopped?.reason === "removed" && member.stopped.at === at) this.store.setRoom(id, { ...member, stopped: { reason: "removed", at: from } });
    }
    this.schedulePurge(agentId, from);
    return { ok: true, removed: ids, undoMs: this.undoMs() };
  }

  /** Brings back an agent removed within the undo window, with the agents
   * that went with it. They come back idle (their turn was ended), with
   * whatever they had reported. */
  restoreAgent(roomId: string, agentId: string): RestoreAgentResult {
    const room = this.store.getRoom(agentId);
    // Only what the person removed (the root of the subtree) is restored: an
    // agent under it comes back with it, never alone under a hidden parent.
    const parentRemoved = room?.parentId !== undefined && this.store.getRoom(room.parentId)?.stopped?.reason === "removed";
    if (this.store.getRoom(roomId)?.role !== "principal" || room?.roomId !== roomId || room.stopped?.reason !== "removed" || parentRemoved) {
      return { ok: false, status: 404, error: "no removed agent with that id in this room (it may have been deleted for good)" };
    }
    const timer = this.purgeTimers.get(agentId);
    if (timer) clearTimeout(timer);
    this.purgeTimers.delete(agentId);
    this.discardOnPurge.delete(agentId);
    const restored: string[] = [];
    for (const id of this.subtreeOf(roomId, agentId)) {
      const member = this.store.getRoom(id);
      if (member?.stopped?.reason !== "removed") continue;
      const { stopped: _stopped, ...rest } = member;
      void _stopped;
      this.store.setRoom(id, rest);
      restored.push(id);
    }
    this.considerDigestFor(agentId);
    return { ok: true, restored };
  }

  private undoMs(): number {
    return this.options.removeUndoMs ?? 15_000;
  }

  private schedulePurge(rootId: string, removedAt: number): void {
    const existing = this.purgeTimers.get(rootId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => this.purge(rootId), Math.max(0, removedAt + this.undoMs() - this.now()));
    timer.unref();
    this.purgeTimers.set(rootId, timer);
  }

  private purge(rootId: string): void {
    this.purgeTimers.delete(rootId);
    const room = this.store.getRoom(rootId);
    if (room?.stopped?.reason !== "removed") return;
    const ids = this.subtreeOf(room.roomId, rootId);
    const discard = this.discardOnPurge.get(rootId) ?? [];
    this.discardOnPurge.delete(rootId);
    this.options.deleteAgent?.(rootId);
    this.options.onPurged?.(ids);
    // The person said "discard anyway": the worktrees go once the agents
    // can no longer be brought back (a restart in between keeps them,
    // retained, which is the safe side).
    const worktrees = this.options.worktrees;
    if (worktrees) {
      for (const id of discard) worktrees.discard(id).catch((error: unknown) => console.warn(`[relay] discarding worktree ${id} failed: ${(error as Error).message}`));
    }
  }

  /** The worktrees agents of the room created, retained ones included. */
  async worktreesOf(roomId: string, options: { size?: boolean } = {}): Promise<WorktreeInfo[]> {
    return (await this.options.worktrees?.list(roomId, options)) ?? [];
  }

  /** After a restart: removals whose window is over are deleted now, the
   * others get their timer back. Only the roots of removed subtrees matter. */
  sweepRemoved(): void {
    for (const id of this.store.listIds()) {
      const room = this.store.getRoom(id);
      if (room?.role !== "worker" || room.stopped?.reason !== "removed") continue;
      if (this.store.getRoom(room.parentId!)?.stopped?.reason === "removed") continue;
      this.schedulePurge(id, room.stopped.at);
    }
  }

  /** Whether a question or a tool approval of `id` waits for the person: read
   * from what is persisted, not from the process, which may be asleep. */
  private awaitingUser(id: string): boolean {
    return this.store.getPendingChoice(id) !== undefined || this.store.getPendingApproval(id) !== undefined;
  }

  private stateOf(id: string, room: RoomMembership): RoomAgentState {
    return roomAgentState(room, this.options.sessions.peek(id)?.isBusy() ?? false, this.awaitingUser(id));
  }

  /** Whether the card of a worker can be answered now. Answering puts the
   * agent back to work, and an agent waiting for the person takes no place
   * under the cap, so the room may have filled up meanwhile; then the answer
   * is refused and the card stays open. A v1 limit: a later version may let
   * the answer wait its turn instead. */
  answerRefusal(sessionId: string): "room_cap_reached" | undefined {
    const room = this.store.getRoom(sessionId);
    if (room?.role !== "worker") return undefined;
    if (takesRoomPlace(this.stateOf(sessionId, room))) return undefined;
    return this.placesTaken(room.roomId) >= ROOM_MAX_LIVE_AGENTS ? "room_cap_reached" : undefined;
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
    // Whatever stopped an earlier digest from going out, a turn of its own
    // since is a reason to try again.
    if (outcome.synthetic !== "room_digest") this.digestFailed.delete(sessionId);
    if (outcome.synthetic === "room_digest") {
      const digest = this.digests.get(sessionId);
      this.digests.delete(sessionId);
      if (digest && !digest.delivered && (outcome.error !== undefined || outcome.stopped)) this.digestFailed.add(sessionId);
    }
    this.endWarmUp(sessionId);
    const sending = this.sending.get(sessionId);
    this.sending.delete(sessionId);
    const room = this.store.getRoom(sessionId);
    if (!room) return;
    if (room.role !== "worker" || room.stopped) {
      // The principal's own turn is over: reports that waited for it go out.
      if (room.role === "principal") this.considerDigest(sessionId);
      return;
    }
    if (sending && !sending.delivered) {
      // The queued message never reached the agent. With the host away it
      // stays queued, untouched, for when the host is back (the queues are
      // resumed on every connection); with the host there, it was refused,
      // and is dropped with the failure reported below.
      if (!this.options.hostConnected()) return;
      this.removeQueued(sessionId, sending);
    }
    // A digest is about the agents below this one: no report of its own is
    // owed for it.
    if (!outcome.stopped && outcome.synthetic !== "room_digest") {
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
      } else if (!reportedThisTurn && !this.awaitingUser(sessionId)) {
        // Not blocked when it ended its turn to wait for the person: it is
        // waiting for them, which is its own state.
        this.recordReport(sessionId, room, { status: "blocked", summary: "The agent ended its turn without reporting.", artifacts: [], synthetic: true });
      }
    }
    this.pump(sessionId);
    // Its own digest may have been waiting for this turn; so may whoever
    // reads what this agent reported.
    this.considerDigest(sessionId);
    this.considerDigestFor(sessionId);
    this.cleanWorktrees(sessionId);
  }

  /** What `RoomWorktrees` asks about an agent: whether it exists, has a turn
   * running, is done (reported, nothing queued), and where it works. */
  worktreeAgentFacts(agentId: string): { exists: boolean; busy: boolean; done: boolean; title?: string; cwd?: string; roomId?: string } {
    const room = this.store.getRoom(agentId);
    // A store that did not load whole says nothing of who is gone.
    if (!room && !this.store.loadedOk) return { exists: true, busy: true, done: false };
    if (!room) return { exists: false, busy: false, done: true };
    // With the host away a turn may be running that this relay cannot see:
    // nothing is removed under an agent it cannot tell is idle.
    if (!this.options.hostConnected()) return { exists: true, busy: true, done: false, roomId: room.roomId };
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
    if (this.parkBehindLeader(sessionId)) return;
    const sending = { text: next.text, at: next.at, delivered: false };
    this.sending.set(sessionId, sending);
    session.submitAgentTurn(next.text, {
      onDelivered: () => {
        sending.delivered = true;
        this.removeQueued(sessionId, sending);
        const key = this.warmingKeyOf.get(sessionId);
        const warming = key === undefined ? undefined : this.warming.get(key);
        if (warming?.leader === sessionId) {
          warming.cancel?.();
          warming.cancel = (this.options.schedule ?? defaultSchedule)(() => this.endWarmUp(sessionId), this.options.warmUpMs ?? ROOM_WARM_UP_MS);
        }
      },
    });
  }

  /** Whether `sessionId`, about to start its very first turn on a Claude
   * model, has to wait behind a sibling of the same model that is warming
   * the cache (it is then started when that one's window closes). Otherwise
   * it becomes the one the others wait behind. A later turn of an agent
   * already born is never held. */
  private parkBehindLeader(sessionId: string): boolean {
    if (this.released.delete(sessionId)) return false;
    const runtime = this.store.getAgentId(sessionId);
    if (runtime !== "claude" || this.store.getSessionId(sessionId, runtime) !== undefined) return false;
    // Per room: the system prompt (and so the cache prefix) is the room's own.
    const key = `${this.store.getRoom(sessionId)?.roomId ?? ""}:${runtime}:${this.store.getModel(sessionId, runtime) ?? ""}`;
    const warming = this.warming.get(key);
    if (!warming) {
      // Until its message is delivered (the window then starts), a bound on
      // how long the others can wait if that never happens (its turn was
      // discarded before it began).
      const cancel = (this.options.schedule ?? defaultSchedule)(() => this.endWarmUp(sessionId), (this.options.warmUpMs ?? ROOM_WARM_UP_MS) + 30_000);
      this.warming.set(key, { leader: sessionId, waiting: new Set(), cancel });
      this.warmingKeyOf.set(sessionId, key);
      return false;
    }
    if (warming.leader === sessionId) return false;
    warming.waiting.add(sessionId);
    return true;
  }

  /** The cache is written (or the leader's turn ended): the agents that
   * waited go. */
  private endWarmUp(leaderId: string): void {
    const key = this.warmingKeyOf.get(leaderId);
    if (key === undefined) return;
    this.warmingKeyOf.delete(leaderId);
    const warming = this.warming.get(key);
    if (warming?.leader !== leaderId) return;
    this.warming.delete(key);
    warming.cancel?.();
    for (const id of warming.waiting) this.released.add(id);
    for (const id of warming.waiting) this.pump(id);
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
   * now or on a later connection, and the round it was part of may be over. */
  onMemberDeleted(sessionId: string): void {
    const timer = this.digestTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.digestTimers.delete(sessionId);
    this.digests.delete(sessionId);
    this.digestFailed.delete(sessionId);
    // Once it is really gone, whoever it was working for may have nothing
    // left to wait for.
    const above = liveAncestorId(sessionId, (id) => this.store.getRoom(id));
    if (above !== undefined) setImmediate(() => this.considerDigest(above));
    // Once the deletion has finished (its record is gone), what it had
    // integrated is cleaned up, and the rest kept and listed by the sweep.
    const worktrees = this.options.worktrees;
    if (worktrees) {
      setImmediate(() => {
        worktrees.cleanupAgent(sessionId, { auto: true }).catch((error: unknown) => console.warn(`[relay] worktree cleanup of deleted agent ${sessionId} failed: ${(error as Error).message}`));
      });
    }
    this.endWarmUp(sessionId);
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
    this.considerAllDigests();
  }

  /** Stores a worker's report and puts it in the outbox of the agent that
   * reads it: the closest one above it that is still there. */
  private recordReport(workerId: string, worker: RoomMembership, report: Omit<NonNullable<RoomMembership["report"]>, "at">): void {
    // Read again: `worker` may predate a change made since (a queued
    // message that was just dropped).
    this.store.setRoom(workerId, { ...(this.store.getRoom(workerId) ?? worker), report: { ...report, at: this.now() } });
    const recipientId = liveAncestorId(workerId, (id) => this.store.getRoom(id));
    const recipient = recipientId === undefined ? undefined : this.store.getRoom(recipientId);
    if (recipientId === undefined || !recipient) return;
    const outbox = recipient.undeliveredReports ?? [];
    if (!outbox.includes(workerId)) this.store.setRoom(recipientId, { ...recipient, undeliveredReports: [...outbox, workerId] });
    // News for whoever was left alone after a digest that failed.
    this.digestFailed.delete(recipientId);
    this.considerDigest(recipientId);
  }

  // ------------------------------------------------------------ digest

  /** The agents below `recipientId` (at any depth) in one of `states`. */
  private countBelow(recipientId: string, states: readonly RoomAgentState[]): number {
    const parentOf = (id: string): string | undefined => this.store.getRoom(id)?.parentId;
    const roomId = this.store.getRoom(recipientId)?.roomId;
    return this.members(roomId ?? recipientId).filter((member) => member.id !== recipientId && isDescendant(member.id, recipientId, parentOf) && states.includes(this.stateOf(member.id, member.room))).length;
  }

  /** What `recipientId` has not been told yet, from the reports as they are
   * now (a report made again replaces the earlier one). */
  private outboxEntries(recipientId: string): { entry: DigestEntry; at: number }[] {
    const recipient = this.store.getRoom(recipientId);
    const entries: { entry: DigestEntry; at: number }[] = [];
    for (const workerId of recipient?.undeliveredReports ?? []) {
      const worker = this.store.getRoom(workerId);
      if (!worker?.report || worker.roomId !== recipient?.roomId) continue;
      // Taken out of the room by the person: not reported on unless brought back.
      if (worker.stopped?.reason === "removed") continue;
      entries.push({
        entry: {
          agentId: workerId,
          title: this.store.getTitle(workerId),
          status: worker.report.status,
          summary: worker.report.summary,
          artifacts: worker.report.artifacts,
          fromRelay: worker.report.synthetic === true,
        },
        at: worker.report.at,
      });
    }
    return entries;
  }

  /** Whether a digest to `recipientId` is due now: it has reports waiting,
   * and either one of them failed or blocked (somebody has to decide) or
   * nothing under it is still running (the round is over). Never while one
   * is already on its way. */
  private digestDue(recipientId: string): boolean {
    if (this.digests.has(recipientId) || this.digestFailed.has(recipientId) || this.admit(recipientId) !== undefined) return false;
    const entries = this.outboxEntries(recipientId);
    if (entries.length === 0) return false;
    return entries.some(({ entry }) => isUrgent(entry.status)) || this.countBelow(recipientId, ["working", "queued"]) === 0;
  }

  /** Schedules the digest if one is due; the window lets agents that report
   * together share it. Called whenever something that can make one due
   * happens. */
  private considerDigest(recipientId: string): void {
    if (this.digestTimers.has(recipientId) || !this.digestDue(recipientId)) return;
    const timer = setTimeout(() => {
      this.digestTimers.delete(recipientId);
      this.deliverDigest(recipientId);
    }, this.options.digestWindowMs ?? 2000);
    timer.unref();
    this.digestTimers.set(recipientId, timer);
  }

  /** `considerDigest` for whoever reads the reports of `workerId`'s side of
   * the tree: it just stopped working, so the round may be over. */
  private considerDigestFor(workerId: string): void {
    const recipientId = liveAncestorId(workerId, (id) => this.store.getRoom(id));
    if (recipientId !== undefined) this.considerDigest(recipientId);
  }

  private deliverDigest(recipientId: string): void {
    // The host being away is no reason to fail a turn nobody asked for: the
    // reports stay in the outbox and go out when it is back.
    if (!this.digestDue(recipientId) || !this.options.hostConnected()) return;
    const entries = this.outboxEntries(recipientId);
    const text = buildRoomDigest(
      entries.map(({ entry }) => entry),
      { stillWorking: this.countBelow(recipientId, ["working", "queued"]), awaitingPerson: this.countBelow(recipientId, ["awaiting_user"]) },
    );
    const taken = new Map(entries.map(({ entry, at }) => [entry.agentId, at]));
    const digest = { delivered: false };
    this.digests.set(recipientId, digest);
    this.options.sessions.getOrCreate(recipientId).submitRoomDigest(text, {
      onDelivered: () => {
        digest.delivered = true;
        this.clearFromOutbox(recipientId, taken);
      },
    });
  }

  /** Takes reports out of an outbox once they were handed over — those that
   * were not made again since (`at` is when the one that was handed over
   * arrived). Also drops entries whose agent is gone. */
  private clearFromOutbox(recipientId: string, handed: ReadonlyMap<string, number>): void {
    const recipient = this.store.getRoom(recipientId);
    if (!recipient?.undeliveredReports) return;
    const kept = recipient.undeliveredReports.filter((workerId) => {
      const report = this.store.getRoom(workerId)?.report;
      if (!report) return false;
      const at = handed.get(workerId);
      return at === undefined || report.at !== at;
    });
    const { undeliveredReports: _old, ...rest } = recipient;
    void _old;
    this.store.setRoom(recipientId, recipient.role === "principal" || kept.length > 0 ? { ...rest, undeliveredReports: kept } : rest);
  }

  /** An agent leaves the room's active work (stopped, removed): reports
   * waiting for it go to the next agent above, and the round may be over. */
  private handOffOutbox(agentId: string): void {
    const timer = this.digestTimers.get(agentId);
    if (timer) clearTimeout(timer);
    this.digestTimers.delete(agentId);
    this.digests.delete(agentId);
    const room = this.store.getRoom(agentId);
    const waiting = room?.undeliveredReports ?? [];
    const targetId = liveAncestorId(agentId, (id) => this.store.getRoom(id));
    const target = targetId === undefined ? undefined : this.store.getRoom(targetId);
    if (room && waiting.length > 0 && targetId !== undefined && target) {
      const { undeliveredReports: _old, ...rest } = room;
      void _old;
      this.store.setRoom(agentId, rest);
      const merged = [...(target.undeliveredReports ?? [])];
      for (const workerId of waiting) if (!merged.includes(workerId)) merged.push(workerId);
      this.store.setRoom(targetId, { ...target, undeliveredReports: merged });
    }
    if (targetId !== undefined) this.considerDigest(targetId);
  }

  /** Looks at every agent that may owe someone a digest (after a restart, or
   * once the host is back). */
  considerAllDigests(): void {
    // A digest that failed because the host went away is worth another try
    // once it is back.
    this.digestFailed.clear();
    for (const id of this.store.listIds()) if ((this.store.getRoom(id)?.undeliveredReports?.length ?? 0) > 0) this.considerDigest(id);
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
    return this.launchWorker(caller.roomId, callerId, parsed.value, "agent");
  }

  /** Starts a worker for whoever asked: the principal's `delegate`, or the
   * person from the canvas. `defaultParentId` is the parent when `args` name
   * none. */
  private launchWorker(roomId: string, defaultParentId: string, args: DelegateArgs, createdBy: "user" | "agent"): RoomToolResult {
    const runtimes = this.runtimes();
    if (!runtimes.includes(args.runtime)) return fail(`Unknown runtime "${args.runtime}". Use one of: ${runtimes.join(", ")}.`);
    const members = this.members(roomId);
    const parentId = args.parentId ?? defaultParentId;
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
      createdBy,
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
    if (integrated) {
      this.options.worktrees?.declareIntegratedFor(callerId, "agent").catch((error: unknown) => console.warn(`[relay] could not record that agent ${callerId}'s work is integrated: ${(error as Error).message}`));
    }
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

  /** The CLI of a worker asks whether a tool call may run. The worker's
   * session answers at once (it defers: the call is refused, the turn ends,
   * the person is asked) so nothing is held open for a person. */
  private async approve(callerId: string, caller: RoomMembership, args: unknown): Promise<RoomToolResult> {
    if (caller.role !== "worker") return fail("Only an agent started in the room is asked about tool calls.");
    const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const decision = await this.options.sessions
      .getOrCreate(callerId)
      .checkPermission(toolName, input.input, typeof input.tool_use_id === "string" ? input.tool_use_id : undefined, typeof input.agent_id === "string" ? input.agent_id : undefined);
    return ok(JSON.stringify(decision));
  }

  private roomStatus(callerId: string, caller: RoomMembership): RoomToolResult {
    const agents = this.members(caller.roomId)
      .filter((member) => member.id !== callerId && member.room.role === "worker" && member.room.stopped?.reason !== "removed")
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
