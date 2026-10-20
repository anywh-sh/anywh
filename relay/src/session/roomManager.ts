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
import type { RoomBridge, RoomToolHost, RoomToolResult } from "../bridges/roomBridge.js";
import { checkDirectory } from "../fs/fsBrowse.js";
import { toHostPlatform } from "../runtimes/hostPlatform.js";
import type { Registry } from "../runtimes/registry.js";
import type { ModelCatalog, RoomAgentSetup, RoomToolSpec } from "../runtimes/types.js";
import { availableModes, isOfferedMode } from "./permissionModes.js";
import { ROOM_MAX_LIVE_AGENTS, isDescendant, isLiveMember, titleFromTask, type RoomMembership } from "./room.js";
import {
  ROOM_MCP_SERVER_NAME,
  parseDelegateArgs,
  parseMessageAgentArgs,
  parseReportArgs,
  principalInstructions,
  roomToolsFor,
  workerInstructions,
} from "./roomTools.js";
import type { SessionStore } from "./sessionStore.js";
import type { SharedSession } from "./sharedSession.js";

/** The runtimes the agent host can run. */
export const HOST_RUNTIMES: readonly string[] = ["claude", "codex"];

export interface RoomSessions {
  getOrCreate(id: string): SharedSession;
  renameTitle(id: string, title: string): boolean;
}

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

const ok = (text: string): RoomToolResult => ({ text, isError: false });
const fail = (text: string): RoomToolResult => ({ text, isError: true });

export class RoomManager implements RoomToolHost {
  private readonly now: () => number;

  constructor(private readonly options: RoomManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  private get store(): SessionStore {
    return this.options.store;
  }

  private runtimes(): readonly string[] {
    return this.options.runtimes().filter((id) => HOST_RUNTIMES.includes(id) && this.options.registry.get(id) !== undefined);
  }

  /** The room wiring of a member, for its driver. */
  setupFor(sessionId: string): RoomAgentSetup | undefined {
    const room = this.store.getRoom(sessionId);
    if (!room) return undefined;
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
    if (!room || room.stopped) return undefined;
    if (this.store.getRoom(room.roomId)?.role !== "principal") return undefined;
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
    const live = members.filter((member) => isLiveMember(member.room)).length;
    if (live >= ROOM_MAX_LIVE_AGENTS) {
      return fail(`This room already has ${live} live agents, the limit is ${ROOM_MAX_LIVE_AGENTS}. Wait for one to report, or ask the person to stop one, before delegating more.`);
    }
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
    });
    // Titled before its first turn, so no title is generated for it.
    this.store.setTitle(workerId, titleFromTask(args.task));
    this.options.sessions.getOrCreate(workerId).submitAgentTurn(args.task);
    return ok(JSON.stringify({ agentId: workerId }));
  }

  private report(callerId: string, caller: RoomMembership, rawArgs: unknown): RoomToolResult {
    if (caller.role !== "worker") return fail("Only an agent started in the room reports; the principal answers the person directly.");
    const parsed = parseReportArgs(rawArgs);
    if (!parsed.ok) return fail(parsed.error);
    this.store.setRoom(callerId, { ...caller, report: { ...parsed.value, at: this.now() } });
    const principal = this.store.getRoom(caller.roomId);
    if (principal?.role === "principal") {
      const outbox = principal.undeliveredReports ?? [];
      if (!outbox.includes(callerId)) this.store.setRoom(caller.roomId, { ...principal, undeliveredReports: [...outbox, callerId] });
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
    this.options.sessions.getOrCreate(agentId).submitAgentTurn(text);
    return ok(`Message queued for ${this.store.getTitle(agentId) ?? agentId}; it is delivered as its next turn.`);
  }

  private roomStatus(callerId: string, caller: RoomMembership): RoomToolResult {
    const agents = this.members(caller.roomId)
      .filter((member) => member.id !== callerId && member.room.role === "worker")
      .map(({ id, room }) => {
        const runtime = this.store.getAgentId(id);
        const session = this.options.sessions.getOrCreate(id);
        const state = room.stopped ? "stopped" : session.isTurnInFlight() ? "working" : (room.report?.status ?? "idle");
        return {
          agentId: id,
          title: this.store.getTitle(id),
          runtime,
          model: this.store.getModel(id, runtime) ?? null,
          parentId: room.parentId,
          ...(room.area ? { area: room.area } : {}),
          state,
          ...(room.report ? { report: { status: room.report.status, summary: room.report.summary, artifacts: room.report.artifacts } } : {}),
        };
      });
    return ok(JSON.stringify({ agents, liveLimit: ROOM_MAX_LIVE_AGENTS }));
  }
}
