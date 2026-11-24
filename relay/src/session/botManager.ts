// What bots do: creating one (a room plus an identity), answering the tools
// only bots have, keeping their task lists, firing their schedules, and
// describing them to clients. The room machinery (delegation, workers,
// reports, worktrees) is the room's, unchanged; this file only adds what a
// room that never ends needs on top (see bot.ts).
import { randomBytes, randomUUID } from "node:crypto";
import { BOT_TURN_NOTE_PREFIX } from "../protocol/relayNote.js";
import type { RoomToolResult } from "../bridges/roomBridge.js";
import { promptDraft, type PushNotificationDraft } from "../push/events.js";
import {
  BOT_OPEN_TASKS_MAX,
  BOT_SCHEDULES_MAX,
  cleanBotName,
  defaultMascot,
  isBotMascot,
  isClosed,
  pruneTasks,
  taskStatus,
  withNote,
  withRun,
  type BotRecord,
  type BotRunOutcome,
  type BotSchedule,
  type BotTask,
  type BotTaskStatus,
} from "./bot.js";
import { SOUL_MAX, memoryForPrompt, type BotFiles, type MemoryLine } from "./botFiles.js";
import {
  parseBotAskArgs,
  parseBotHandoffArgs,
  peerAnswerText,
  peerAskText,
  peerClosedText,
  peerHandoffText,
  peerNoAnswerText,
  peerPurpose,
  peerRosterNote,
  resolvePeer,
  sendWindow,
  BOT_PEER_SENDS_PER_HOUR,
  type PeerNoAnswer,
} from "./botPeers.js";
import { checkCron, dueDecision, nextRunAfter } from "./botSchedule.js";
import type { BotStore } from "./botStore.js";
import {
  BOT_FIRST_RUN_NOTE,
  botClockNote,
  botAnswerText,
  botCancelText,
  botInstructions,
  botKickoffText,
  botScheduleText,
  parseForgetArgs,
  parseRememberArgs,
  parseScheduleCreateArgs,
  parseScheduleRemoveArgs,
  parseScheduleUpdateArgs,
  parseSetSoulArgs,
  parseTaskAskArgs,
  parseTaskCreateArgs,
  parseTaskUpdateArgs,
} from "./botTools.js";
import type { RoomAgentState } from "./room.js";
import type { CreateRoomInput, CreateRoomResult, RoomBots } from "./roomManager.js";
import type { SessionStore } from "./sessionStore.js";
import type { BotTurnOutcome } from "./sharedSession.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const ok = (text: string): RoomToolResult => ({ text, isError: false });
/** Whether `stopAgent` stopped it (it answers `{ ok }`; anything else is not). */
const isStopped = (result: unknown): boolean => typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true;
const fail = (text: string): RoomToolResult => ({ text, isError: true });

/** The longest a scheduler timer waits before looking again: bounds the
 * drift of a long sleep and stays far below `setTimeout`'s limit. */
const SCHEDULER_MAX_WAIT_MS = 60 * 60 * 1000;
/** How soon a run that could not start (the agent host away) is retried. */
const SCHEDULER_RETRY_MS = 30 * 1000;
/** A run older than this, with its bot idle, is over even if its end was never
 * reported. The session always reports it (a dropped or failed turn too), so
 * this is only a guard against a bug: it must not hold its schedule forever. */
const RUN_STALE_MS = 60 * 60 * 1000;
/** How long a bot waits after a usage limit whose reset nobody reported. */
const UNKNOWN_RESET_HOLD_MS = 60 * 60 * 1000;

/** The live session of a bot's room, as much of it as bots use. */
export interface BotSession {
  submitBotTurn(text: string, turn: { kind: "bot_schedule" | "bot_note"; label: string; onSettled?: (outcome: BotTurnOutcome) => void }): void;
  isBusy(): boolean;
  isAnyoneLooking(): boolean;
}

export interface BotManagerOptions {
  readonly store: BotStore;
  readonly files: BotFiles;
  readonly sessionStore: SessionStore;
  readonly rooms: {
    createRoom(input: CreateRoomInput): CreateRoomResult;
    agentState(id: string): RoomAgentState | undefined;
    /** Stops one worker of the room (the person's Stop). */
    stopAgent(roomId: string, agentId: string): Promise<unknown>;
  };
  readonly sessions: {
    getOrCreate(id: string): BotSession;
    peek(id: string): BotSession | undefined;
    renameTitle(id: string, title: string): boolean;
    deleteSession(id: string): boolean;
  };
  /** Runtimes a bot can run on and delegate to. */
  readonly runtimes: () => readonly string[];
  readonly hostConnected: () => boolean;
  /** Tells the person's devices that a bot needs them. */
  readonly notifyPerson?: (event: { roomId: string; draft: PushNotificationDraft; watched: boolean }) => void;
  readonly now?: () => number;
  /** Time zone schedules are read in; the host's by default. */
  readonly timezone?: string;
  /** Replaceable timers, so a test steps time by hand. */
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
  /** When the agent's spent plan window resets, as its plan usage says;
   * `undefined` when unknown (the bot then waits an hour). */
  readonly usageResetAt?: (agentId: string) => number | undefined;
}

export interface CreateBotInput {
  name?: unknown;
  mascot?: unknown;
  soul?: unknown;
  templateId?: unknown;
  schedules?: unknown;
  agentId?: unknown;
  model?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  cwd?: unknown;
}

export type BotResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** A worker of a task, as the task list shows it. */
export interface BotWorkerView {
  agentId: string;
  title: string | null;
  state: RoomAgentState | "gone";
  startedAt?: number;
}

export interface BotTaskView {
  n: number;
  title: string;
  status: BotTaskStatus;
  doneMeans?: string;
  question?: BotTask["question"];
  /** The bot that handed it over; `name` is null once that bot is gone. */
  from?: { botId: string; name: string | null };
  notes: BotTask["notes"];
  workers: BotWorkerView[];
  createdAt: number;
  updatedAt: number;
}

export interface BotScheduleView {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  paused: boolean;
  nextRunAt?: number;
  running: boolean;
  runs: BotSchedule["runs"];
}

/** A bot as the sidebar lists it. */
export interface BotSummary {
  id: string;
  roomId: string;
  name: string;
  mascot: BotRecord["mascot"];
  paused: boolean;
  firstRun: boolean;
  templateId?: string;
  /** Tasks (and its own conversation) waiting for the person. */
  needsYou: number;
  /** Its workers at work. */
  working: number;
  /** Its own turn is running. */
  busy: boolean;
  /** The task that last moved, for the status line. */
  latestTask?: { n: number; title: string; status: BotTaskStatus; updatedAt: number };
  /** The next schedule to fire, if any. */
  nextRun?: { name: string; at: number };
  /** The latest schedule run failed. */
  lastRunFailed: boolean;
  /** Its agent hit a usage limit: back at this time. */
  limitedUntil?: number;
  createdAt: number;
  /** How many schedules it has, paused or not. */
  scheduleCount: number;
  /** Its schedules' runs in the last 24 hours, by how each ended (from the
   * runs each schedule keeps, so at most that many per schedule). */
  runs24h: Record<BotRunOutcome, number>;
  /** What it sent other bots in the last 24 hours. Counted in memory: a
   * relay restart starts it from zero. */
  peer24h: { asks: number; handoffs: number };
}

/** A bot as its room's channel shows it. */
export interface BotView extends BotSummary {
  /** Its own conversation waits for the person (a question or an approval). */
  conversationNeedsYou: boolean;
  tasks: BotTaskView[];
  schedules: BotScheduleView[];
}

function defaultTimer(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

export class BotManager implements RoomBots {
  private readonly now: () => number;
  private cancelTimer?: () => void;
  /** Schedules (by `botId:scheduleId`) whose run is under way, with when it
   * started. See `isRunning`. */
  private readonly running = new Map<string, number>();
  private started = false;
  /** Questions between bots waiting for their answer, as `asker>asked`:
   * one at a time per pair. In memory only: a restart drops them, and frees
   * the pair. */
  private readonly openQuestions = new Set<string>();
  /** When each bot sent its latest messages to other bots (see `sendWindow`). */
  private readonly sends = new Map<string, number[]>();
  /** Each bot's sends to other bots in the last day, for its summary. */
  private readonly peerSent = new Map<string, { at: number; kind: "ask" | "handoff" }[]>();

  constructor(private readonly options: BotManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  private get store(): BotStore {
    return this.options.store;
  }

  /** The time zone schedules are read in (the host's unless given). */
  private timeZone(): string {
    return this.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  // ------------------------------------------------------------ person

  create(input: CreateBotInput): BotResult<BotSummary> {
    const name = cleanBotName(input.name);
    if (!name) return { ok: false, status: 400, error: "name is required (at most 40 characters)" };
    if (typeof input.soul !== "string" || input.soul.trim() === "" || input.soul.length > SOUL_MAX) return { ok: false, status: 400, error: "soul must be a non-empty string" };
    if (input.templateId !== undefined && (typeof input.templateId !== "string" || input.templateId.length > 64)) return { ok: false, status: 400, error: "templateId must be a string" };
    const mascot = input.mascot === undefined ? defaultMascot(name) : input.mascot;
    if (!isBotMascot(mascot)) return { ok: false, status: 400, error: "mascot must be { character, tone } of known ones" };
    const schedules = this.parseInitialSchedules(input.schedules);
    if (!schedules.ok) return schedules;
    if (!this.options.hostConnected()) return { ok: false, status: 503, error: "the agent host is not running, so a bot cannot start now" };
    const id = randomUUID();
    const roomId = randomUUID();
    const at = this.now();
    const bot: BotRecord = {
      id,
      name,
      mascot: { character: mascot.character, tone: mascot.tone },
      roomId,
      ...(typeof input.templateId === "string" ? { templateId: input.templateId } : {}),
      paused: false,
      firstRun: true,
      createdAt: at,
      nextTaskN: 1,
      tasks: [],
      schedules: schedules.value.map((each) => ({ ...each, id: this.scheduleId(), createdAt: at, runs: [] })),
    };
    // Registered before its room exists: the room's session is born knowing
    // it is a bot (approvals put to the person, kept off the conversation
    // list), with nothing to patch up afterwards.
    this.options.files.create(id, input.soul);
    this.store.put(bot);
    // A room that is refused, or that throws partway, takes the bot back
    // out: never a bot listed whose conversation does not exist.
    const undo = (): void => {
      this.store.delete(id);
      this.options.files.remove(id);
    };
    let room: CreateRoomResult;
    try {
      room = this.options.rooms.createRoom({ agentId: input.agentId, model: input.model, effort: input.effort, permissionMode: input.permissionMode, cwd: input.cwd, title: name, roomId });
    } catch (error) {
      undo();
      throw error;
    }
    if (!room.ok) {
      undo();
      return { ok: false, status: 400, error: room.error };
    }
    this.options.sessions.getOrCreate(roomId).submitBotTurn(botKickoffText(), { kind: "bot_note", label: "created", onSettled: (outcome) => this.turnSettled(id, outcome) });
    this.arm();
    return { ok: true, value: this.summary(this.store.get(id)!) };
  }

  private parseInitialSchedules(raw: unknown): BotResult<Omit<BotSchedule, "id" | "createdAt" | "runs">[]> {
    if (raw === undefined) return { ok: true, value: [] };
    if (!Array.isArray(raw) || raw.length > BOT_SCHEDULES_MAX) return { ok: false, status: 400, error: `schedules must be a list of at most ${BOT_SCHEDULES_MAX}` };
    const out: Omit<BotSchedule, "id" | "createdAt" | "runs">[] = [];
    for (const each of raw) {
      const parsed = parseScheduleCreateArgs(each);
      if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
      const cron = checkCron(parsed.value.cron);
      if (!cron.ok) return { ok: false, status: 400, error: cron.error };
      // A template's schedules wait for the person to turn them on.
      const paused = typeof each === "object" && each !== null && (each as { paused?: unknown }).paused === false ? false : true;
      out.push({ ...parsed.value, paused });
    }
    return { ok: true, value: out };
  }

  remove(id: string): boolean {
    const bot = this.store.get(id);
    if (!bot) return false;
    for (const schedule of bot.schedules) this.running.delete(`${id}:${schedule.id}`);
    this.tellSendersOfDeleted(bot);
    this.store.delete(id);
    this.options.sessions.deleteSession(bot.roomId);
    this.options.files.remove(id);
    this.arm();
    return true;
  }

  /** A bot whose room is gone (deleted as a session) goes with it. */
  onRoomDeleted(roomId: string): void {
    const bot = this.store.byRoom(roomId);
    if (!bot) return;
    this.tellSendersOfDeleted(bot);
    this.store.delete(bot.id);
    this.options.files.remove(bot.id);
    this.arm();
  }

  patch(id: string, input: { name?: unknown; mascot?: unknown; paused?: unknown; soul?: unknown }): BotResult<BotSummary> {
    const bot = this.store.get(id);
    if (!bot) return { ok: false, status: 404, error: "bot not found" };
    let name = bot.name;
    if (input.name !== undefined) {
      const cleaned = cleanBotName(input.name);
      if (!cleaned) return { ok: false, status: 400, error: "name must be a non-empty string of at most 40 characters" };
      name = cleaned;
    }
    if (input.mascot !== undefined && !isBotMascot(input.mascot)) return { ok: false, status: 400, error: "mascot must be { character, tone } of known ones" };
    if (input.paused !== undefined && typeof input.paused !== "boolean") return { ok: false, status: 400, error: "paused must be true or false" };
    if (input.soul !== undefined && (typeof input.soul !== "string" || input.soul.trim() === "" || input.soul.length > SOUL_MAX)) return { ok: false, status: 400, error: "soul must be a non-empty string" };
    if (typeof input.soul === "string") this.options.files.writeSoul(id, input.soul);
    const next = this.store.update(id, (current) => ({
      ...current,
      name,
      ...(isBotMascot(input.mascot) ? { mascot: { character: input.mascot.character, tone: input.mascot.tone } } : {}),
      ...(typeof input.paused === "boolean" ? { paused: input.paused } : {}),
      // A soul the person wrote is the bot's soul: its first run is over.
      ...(typeof input.soul === "string" ? { firstRun: false } : {}),
    }))!;
    if (name !== bot.name) this.options.sessions.renameTitle(bot.roomId, name);
    this.arm();
    return { ok: true, value: this.summary(next) };
  }

  soulOf(id: string): string | undefined {
    return this.store.get(id) ? this.options.files.readSoul(id) : undefined;
  }

  memoryOf(id: string): MemoryLine[] | undefined {
    return this.store.get(id) ? this.options.files.readMemory(id) : undefined;
  }

  editMemory(id: string, index: number, text: string | null): boolean {
    if (!this.store.get(id)) return false;
    const done = this.options.files.editLine(id, index, text);
    // The memory is part of the bot's state as clients see it.
    if (done) this.store.touch(id);
    return done;
  }

  /** The person answers the question on task `n`: it leaves the task and
   * reaches the bot as its next turn. */
  answerTask(id: string, n: number, answer: unknown): BotResult<null> {
    const bot = this.store.get(id);
    if (!bot) return { ok: false, status: 404, error: "bot not found" };
    const task = bot.tasks.find((each) => each.n === n);
    if (!task?.question) return { ok: false, status: 409, error: "that task has no open question" };
    if (typeof answer !== "string" || answer.trim() === "" || answer.length > 4000) return { ok: false, status: 400, error: "answer must be a non-empty string" };
    const question = task.question.question;
    const at = this.now();
    this.store.update(id, (current) => ({
      ...current,
      tasks: current.tasks.map((each) => {
        if (each.n !== n) return each;
        const { question: _answered, ...rest } = each;
        void _answered;
        return { ...rest, notes: withNote(each.notes, { text: `Answered: ${answer.trim()}`, at }), updatedAt: at };
      }),
    }));
    this.options.sessions.getOrCreate(bot.roomId).submitBotTurn(botAnswerText(n, question, answer.trim()), { kind: "bot_note", label: `answer:${n}`, onSettled: (outcome) => this.turnSettled(bot.id, outcome) });
    return { ok: true, value: null };
  }

  cancelTask(id: string, n: number): BotResult<null> {
    const bot = this.store.get(id);
    const task = bot?.tasks.find((each) => each.n === n);
    if (!bot || !task) return { ok: false, status: 404, error: "task not found" };
    if (isClosed(task.status)) return { ok: true, value: null };
    const at = this.now();
    this.store.update(id, (current) => ({
      ...current,
      tasks: pruneTasks(
        current.tasks.map((each) => {
          if (each.n !== n) return each;
          const { question: _dropped, ...rest } = each;
          void _dropped;
          return { ...rest, status: "canceled", notes: withNote(each.notes, { text: "Canceled by the person.", at }), updatedAt: at };
        }),
      ),
    }));
    this.tellSender(bot.id, task, "canceled", null, true);
    // Nothing keeps working on a task the person called off, and the bot
    // hears it from the relay rather than from a report out of the blue.
    // The note waits for the stops, so it says what actually happened.
    const active = task.workerIds.filter((workerId) => {
      const state = this.options.rooms.agentState(workerId);
      return state === "working" || state === "queued" || state === "awaiting_user" || state === "waiting";
    });
    void Promise.all(
      active.map((workerId) =>
        this.options.rooms.stopAgent(bot.roomId, workerId).then(
          (result) => isStopped(result),
          (error: unknown) => {
            console.warn(`[relay] could not stop agent ${workerId} of a canceled task: ${(error as Error).message}`);
            return false;
          },
        ),
      ),
    ).then((stopped) => {
      const notStopped = active.filter((_, i) => !stopped[i]);
      this.options.sessions.getOrCreate(bot.roomId).submitBotTurn(botCancelText(n, { stopped: active.length - notStopped.length, notStopped }), { kind: "bot_note", label: `cancel:${n}`, onSettled: (outcome) => this.turnSettled(bot.id, outcome) });
    });
    return { ok: true, value: null };
  }

  updateSchedule(id: string, scheduleId: string, input: { paused?: unknown }): BotResult<null> {
    const bot = this.store.get(id);
    if (!bot?.schedules.some((each) => each.id === scheduleId)) return { ok: false, status: 404, error: "schedule not found" };
    if (typeof input.paused !== "boolean") return { ok: false, status: 400, error: "paused must be true or false" };
    this.store.update(id, (current) => ({
      ...current,
      schedules: current.schedules.map((each) => (each.id === scheduleId ? this.armed({ ...each, paused: input.paused as boolean }) : each)),
    }));
    this.arm();
    return { ok: true, value: null };
  }

  removeSchedule(id: string, scheduleId: string): BotResult<null> {
    const bot = this.store.get(id);
    if (!bot?.schedules.some((each) => each.id === scheduleId)) return { ok: false, status: 404, error: "schedule not found" };
    this.store.update(id, (current) => ({ ...current, schedules: current.schedules.filter((each) => each.id !== scheduleId) }));
    this.running.delete(`${id}:${scheduleId}`);
    this.arm();
    return { ok: true, value: null };
  }

  /** The person runs a schedule now ("Run now"), paused or not. */
  runScheduleNow(id: string, scheduleId: string): BotResult<null> {
    const bot = this.store.get(id);
    const schedule = bot?.schedules.find((each) => each.id === scheduleId);
    if (!bot || !schedule) return { ok: false, status: 404, error: "schedule not found" };
    if (this.isRunning(bot, scheduleId)) return { ok: false, status: 409, error: "that schedule is already running" };
    if (!this.options.hostConnected()) return { ok: false, status: 503, error: "the agent host is not running" };
    this.fire(bot, schedule);
    return { ok: true, value: null };
  }

  // ------------------------------------------------------------ room hooks

  isBotRoom(roomId: string): boolean {
    return this.store.isBotRoom(roomId);
  }

  setup(roomId: string): { instructions: string; addDirs: readonly string[] } | undefined {
    const bot = this.store.byRoom(roomId);
    if (!bot) return undefined;
    const files = this.options.files;
    return {
      instructions: botInstructions({ name: bot.name, soul: files.readSoul(bot.id), memory: memoryForPrompt(files.readMemory(bot.id)), runtimes: this.options.runtimes(), folder: files.dirFor(bot.id) }),
      addDirs: [files.dirFor(bot.id)],
    };
  }

  turnNote(roomId: string): string | undefined {
    const bot = this.store.byRoom(roomId);
    if (!bot) return undefined;
    const clock = botClockNote(this.now(), this.timeZone());
    // Who the other bots are, on every turn: a bot that has to call bot_list
    // to learn its peers exist never thinks of involving one on its own.
    const peers = peerRosterNote(
      this.store
        .list()
        .filter((each) => each.id !== bot.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((each) => ({ name: each.name, purpose: peerPurpose(this.options.files.readSoul(each.id)), paused: each.paused })),
    );
    const note = [bot.firstRun ? BOT_FIRST_RUN_NOTE : undefined, clock, peers].filter((part) => part !== undefined).join("\n\n");
    // One note behind a prefix of its own, so a transcript read back can
    // drop all of it (see `stripRelayNote`).
    return `${BOT_TURN_NOTE_PREFIX} ${note}`;
  }

  taskRefusal(roomId: string, taskN: number): string | undefined {
    const task = this.store.byRoom(roomId)?.tasks.find((each) => each.n === taskN);
    if (!task) return `There is no task #${taskN}; create it with task_create first.`;
    if (isClosed(task.status)) return `Task #${taskN} is ${task.status}; reopen it with task_update or create a new one.`;
    return undefined;
  }

  delegated(roomId: string, workerId: string, taskN: number | undefined): void {
    const bot = this.store.byRoom(roomId);
    if (!bot || taskN === undefined) return;
    const at = this.now();
    this.store.update(bot.id, (current) => ({
      ...current,
      tasks: current.tasks.map((each) => (each.n === taskN ? { ...each, status: each.status === "planned" ? "working" : each.status, workerIds: [...each.workerIds, workerId], updatedAt: at } : each)),
    }));
  }

  hasOpenTask(roomId: string, workerId: string): boolean {
    return this.store.hasOpenTaskFor(roomId, workerId);
  }

  status(roomId: string): Record<string, unknown> {
    const bot = this.store.byRoom(roomId);
    if (!bot) return {};
    const titleOf = (id: string): string => this.options.sessionStore.getTitle(id) ?? id;
    return {
      tasks: bot.tasks
        .filter((task) => !isClosed(task.status))
        .map((task) => ({
          task: task.n,
          title: task.title,
          status: taskStatus(task, (id) => this.awaitsPerson(id)),
          ...(task.doneMeans ? { doneMeans: task.doneMeans } : {}),
          ...(task.question ? { question: task.question.question } : {}),
          agents: task.workerIds.map(titleOf),
        })),
      schedules: bot.schedules.map((schedule) => ({
        id: schedule.id,
        name: schedule.name,
        cron: schedule.cron,
        paused: schedule.paused,
        ...(schedule.nextRunAt !== undefined && !schedule.paused ? { nextRun: new Date(schedule.nextRunAt).toISOString() } : {}),
      })),
    };
  }

  callTool(roomId: string, name: string, args: unknown): Promise<RoomToolResult> | undefined {
    const bot = this.store.byRoom(roomId);
    if (!bot) return undefined;
    switch (name) {
      case "task_create":
        return Promise.resolve(this.taskCreate(bot, args));
      case "task_update":
        return Promise.resolve(this.taskUpdate(bot, args));
      case "task_ask":
        return Promise.resolve(this.taskAsk(bot, args));
      case "remember": {
        const parsed = parseRememberArgs(args);
        if (!parsed.ok) return Promise.resolve(fail(parsed.error));
        const { added } = this.options.files.remember(bot.id, { ...parsed.value, source: "conversation" });
        this.store.touch(bot.id);
        return Promise.resolve(ok(added ? "Remembered." : "That is already in your memory."));
      }
      case "forget": {
        const parsed = parseForgetArgs(args);
        if (!parsed.ok) return Promise.resolve(fail(parsed.error));
        const gone = this.options.files.forget(bot.id, parsed.value.text);
        if (gone < 0) return Promise.resolve(fail(`${-gone} lines contain that text; give the exact line.`));
        if (gone === 0) return Promise.resolve(fail("No line of your memory matches that text."));
        this.store.touch(bot.id);
        return Promise.resolve(ok(`Forgot ${gone} line${gone === 1 ? "" : "s"}.`));
      }
      case "set_soul": {
        const parsed = parseSetSoulArgs(args);
        if (!parsed.ok) return Promise.resolve(fail(parsed.error));
        this.options.files.writeSoul(bot.id, parsed.value.text);
        this.store.update(bot.id, (current) => ({ ...current, firstRun: false }));
        return Promise.resolve(ok("Soul written."));
      }
      case "bot_list":
        return Promise.resolve(this.botList(bot));
      case "bot_ask":
        return Promise.resolve(this.botAsk(bot, args));
      case "bot_handoff":
        return Promise.resolve(this.botHandoff(bot, args));
      case "schedule_create":
        return Promise.resolve(this.scheduleCreate(bot, args));
      case "schedule_update":
        return Promise.resolve(this.scheduleUpdate(bot, args));
      case "schedule_remove": {
        const parsed = parseScheduleRemoveArgs(args);
        if (!parsed.ok) return Promise.resolve(fail(parsed.error));
        const removed = this.removeSchedule(bot.id, parsed.value.id);
        return Promise.resolve(removed.ok ? ok("Schedule removed.") : fail(`There is no schedule "${parsed.value.id}"; bot_status lists them.`));
      }
      default:
        return undefined;
    }
  }

  private taskCreate(bot: BotRecord, args: unknown): RoomToolResult {
    const parsed = parseTaskCreateArgs(args);
    if (!parsed.ok) return fail(parsed.error);
    const open = bot.tasks.filter((task) => !isClosed(task.status)).length;
    if (open >= BOT_OPEN_TASKS_MAX) return fail(`You already have ${open} open tasks (the limit); close some with task_update first.`);
    const at = this.now();
    const n = bot.nextTaskN;
    this.store.update(bot.id, (current) => ({
      ...current,
      nextTaskN: current.nextTaskN + 1,
      tasks: [...current.tasks, { n, title: parsed.value.title, status: "planned", ...(parsed.value.doneMeans ? { doneMeans: parsed.value.doneMeans } : {}), workerIds: [], notes: [], createdAt: at, updatedAt: at }],
    }));
    return ok(JSON.stringify({ task: n }));
  }

  private taskUpdate(bot: BotRecord, args: unknown): RoomToolResult {
    const parsed = parseTaskUpdateArgs(args);
    if (!parsed.ok) return fail(parsed.error);
    const { task: n, status, title, note } = parsed.value;
    const target = bot.tasks.find((task) => task.n === n);
    if (!target) return fail(`There is no task #${n}.`);
    // Reopening counts against the same limit as creating.
    if (status !== undefined && !isClosed(status) && isClosed(target.status)) {
      const open = bot.tasks.filter((task) => !isClosed(task.status)).length;
      if (open >= BOT_OPEN_TASKS_MAX) return fail(`You already have ${open} open tasks (the limit); close some before reopening #${n}.`);
    }
    const at = this.now();
    this.store.update(bot.id, (current) => ({
      ...current,
      tasks: pruneTasks(
        current.tasks.map((task) => {
          if (task.n !== n) return task;
          const closing = status === "done" || status === "canceled";
          const { question: _question, ...rest } = task;
          void _question;
          return {
            ...(closing ? rest : task),
            ...(status ? { status } : {}),
            ...(title ? { title } : {}),
            notes: note ? withNote(task.notes, { text: note, at }) : task.notes,
            updatedAt: at,
          };
        }),
      ),
    }));
    if (status === "done" || status === "canceled") this.tellSender(bot.id, target, status, note, false);
    return ok(`Task #${n} updated.`);
  }

  private taskAsk(bot: BotRecord, args: unknown): RoomToolResult {
    const parsed = parseTaskAskArgs(args);
    if (!parsed.ok) return fail(parsed.error);
    const { task: n, question, options, recommended } = parsed.value;
    const task = bot.tasks.find((each) => each.n === n);
    if (!task || isClosed(task.status)) return fail(`There is no open task #${n}.`);
    const at = this.now();
    this.store.update(bot.id, (current) => ({
      ...current,
      tasks: current.tasks.map((each) => (each.n === n ? { ...each, question: { question, options, ...(recommended !== undefined ? { recommended } : {}), askedAt: at }, updatedAt: at } : each)),
    }));
    const session = this.options.sessions.peek(bot.roomId);
    this.options.notifyPerson?.({
      roomId: bot.roomId,
      draft: promptDraft({ title: `${bot.name} · #${n} ${task.title}`, kind: "choice", firstQuestion: question }),
      watched: session?.isAnyoneLooking() ?? false,
    });
    return ok(`Question added to task #${n}; the person is notified. End your turn now: their answer comes back as a message.`);
  }

  // ------------------------------------------------------------ peers

  private botList(bot: BotRecord): RoomToolResult {
    const peers = this.store
      .list()
      .filter((each) => each.id !== bot.id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((each) => ({
        name: each.name,
        id: each.id,
        purpose: peerPurpose(this.options.files.readSoul(each.id)),
        busy: this.options.sessions.peek(each.roomId)?.isBusy() ?? false,
        ...(each.paused ? { paused: true } : {}),
      }));
    if (peers.length === 0) return ok("There are no other bots on this computer.");
    return ok(JSON.stringify({ bots: peers }));
  }

  /** The sender's own task a peer message is for, refused when it is not open. */
  private ownTaskRefusal(bot: BotRecord, taskN: number | undefined): string | undefined {
    if (taskN === undefined) return undefined;
    const task = bot.tasks.find((each) => each.n === taskN);
    if (!task || isClosed(task.status)) return `There is no open task #${taskN} of yours.`;
    return undefined;
  }

  /** Counts one message against the sender's hourly limit, or says why not. */
  private takeSend(bot: BotRecord): string | undefined {
    const now = this.now();
    const window = sendWindow(this.sends.get(bot.id) ?? [], now);
    if (!window.allowed) return `You already sent ${BOT_PEER_SENDS_PER_HOUR} messages to other bots in the last hour (the limit); try again later or ask the person.`;
    this.sends.set(bot.id, [...window.recent, now]);
    return undefined;
  }

  private noteOwnTask(botId: string, taskN: number | undefined, text: string): void {
    if (taskN === undefined) return;
    const at = this.now();
    this.store.update(botId, (current) => ({
      ...current,
      tasks: current.tasks.map((each) => (each.n === taskN ? { ...each, notes: withNote(each.notes, { text, at }), updatedAt: at } : each)),
    }));
  }

  private botAsk(bot: BotRecord, args: unknown): RoomToolResult {
    const parsed = parseBotAskArgs(args);
    if (!parsed.ok) return fail(parsed.error);
    const { question, task } = parsed.value;
    const found = resolvePeer(this.store.list(), bot.id, parsed.value.to);
    if (!found.ok) return fail(found.error);
    const peer = found.value;
    if (peer.paused) return fail(`${peer.name} is paused; ask the person instead.`);
    const refusal = this.ownTaskRefusal(bot, task);
    if (refusal) return fail(refusal);
    const pair = `${bot.id}>${peer.id}`;
    if (this.openQuestions.has(pair)) return fail(`You already asked ${peer.name} something; wait for that answer first.`);
    const limited = this.takeSend(bot);
    if (limited) return fail(limited);
    this.openQuestions.add(pair);
    this.notePeerSent(bot.id, "ask");
    this.noteOwnTask(bot.id, task, `Asked ${peer.name}: ${question.length > 200 ? `${question.slice(0, 199)}…` : question}`);
    this.options.sessions.getOrCreate(peer.roomId).submitBotTurn(peerAskText(bot.name, question), {
      kind: "bot_note",
      label: `peer_ask:${bot.name}`,
      onSettled: (outcome) => {
        this.openQuestions.delete(pair);
        this.turnSettled(peer.id, outcome);
        this.deliverAnswer(bot.id, peer, question, outcome);
      },
    });
    return ok(`Sent to ${peer.name}. Its answer comes back to you as a message; end your turn now.`);
  }

  /** Brings a peer's answer (or why there is none) back to the bot that asked. */
  private deliverAnswer(askerId: string, peer: BotRecord, question: string, outcome: BotTurnOutcome): void {
    const asker = this.store.get(askerId);
    if (!asker) return;
    const name = this.store.get(peer.id)?.name ?? peer.name;
    const reply = outcome.reply?.trim() ?? "";
    const why: PeerNoAnswer | undefined = outcome.limited ? "limited" : outcome.failed ? "failed" : outcome.stopped ? "stopped" : reply === "" ? "empty" : undefined;
    const text = why ? peerNoAnswerText(name, question, why) : peerAnswerText(name, question, reply);
    this.options.sessions.getOrCreate(asker.roomId).submitBotTurn(text, {
      kind: "bot_note",
      label: `${why ? "peer_noanswer" : "peer_answer"}:${name}`,
      onSettled: (settled) => this.turnSettled(asker.id, settled),
    });
  }

  private botHandoff(bot: BotRecord, args: unknown): RoomToolResult {
    const parsed = parseBotHandoffArgs(args);
    if (!parsed.ok) return fail(parsed.error);
    const { title, details, task } = parsed.value;
    const found = resolvePeer(this.store.list(), bot.id, parsed.value.to);
    if (!found.ok) return fail(found.error);
    const peer = found.value;
    if (peer.paused) return fail(`${peer.name} is paused; ask the person instead.`);
    const refusal = this.ownTaskRefusal(bot, task);
    if (refusal) return fail(refusal);
    if (peer.tasks.filter((each) => !isClosed(each.status)).length >= BOT_OPEN_TASKS_MAX) return fail(`${peer.name}'s task list is full; ask the person instead.`);
    const limited = this.takeSend(bot);
    if (limited) return fail(limited);
    const at = this.now();
    const n = peer.nextTaskN;
    this.store.update(peer.id, (current) => ({
      ...current,
      nextTaskN: current.nextTaskN + 1,
      tasks: [
        ...current.tasks,
        { n, title, status: "planned", workerIds: [], from: { botId: bot.id, ...(task !== undefined ? { taskN: task } : {}) }, notes: [{ text: `From ${bot.name}: ${details}`, at }], createdAt: at, updatedAt: at },
      ],
    }));
    this.notePeerSent(bot.id, "handoff");
    this.noteOwnTask(bot.id, task, `Handed to ${peer.name} as #${n}.`);
    this.options.sessions.getOrCreate(peer.roomId).submitBotTurn(peerHandoffText(bot.name, n, title, details), {
      kind: "bot_note",
      label: `peer_handoff:${n}:${bot.name}`,
      onSettled: (outcome) => this.turnSettled(peer.id, outcome),
    });
    return ok(`Handed to ${peer.name} as its task #${n}. You are told when it is done or canceled.`);
  }

  /** A task another bot handed over just closed: that bot hears how. `note`
   * is what to tell with it: the update's own note, `null` for none, or (left
   * out) the task's latest note. */
  private tellSender(botId: string, before: BotTask, status: "done" | "canceled", note: string | null | undefined, byPerson: boolean): void {
    if (!before.from || isClosed(before.status)) return;
    const sender = this.store.get(before.from.botId);
    const holder = this.store.get(botId);
    if (!sender || !holder) return;
    const after = holder.tasks.find((each) => each.n === before.n);
    const lastNote = note === null ? undefined : (note ?? after?.notes.at(-1)?.text);
    const forTaskN = before.from.taskN;
    this.noteOwnTask(sender.id, forTaskN !== undefined && sender.tasks.some((each) => each.n === forTaskN) ? forTaskN : undefined, `${holder.name} closed #${before.n}: ${status}.`);
    this.options.sessions
      .getOrCreate(sender.roomId)
      .submitBotTurn(peerClosedText(holder.name, { n: before.n, title: after?.title ?? before.title, status, ...(lastNote ? { note: lastNote } : {}), byPerson, ...(forTaskN !== undefined ? { forTaskN } : {}) }), {
        kind: "bot_note",
        label: `peer_closed:${before.n}:${holder.name}`,
        onSettled: (outcome) => this.turnSettled(sender.id, outcome),
      });
  }

  /** The bot is being deleted: every bot that handed it a task still open
   * hears that the task is gone, instead of waiting on it forever. */
  private tellSendersOfDeleted(bot: BotRecord): void {
    for (const task of bot.tasks) {
      if (task.from && !isClosed(task.status)) this.tellSender(bot.id, task, "canceled", "The bot that had it was deleted.", true);
    }
  }

  private scheduleCreate(bot: BotRecord, args: unknown): RoomToolResult {
    const parsed = parseScheduleCreateArgs(args);
    if (!parsed.ok) return fail(parsed.error);
    if (bot.schedules.length >= BOT_SCHEDULES_MAX) return fail(`You already have ${bot.schedules.length} schedules (the limit); remove one first.`);
    const cron = checkCron(parsed.value.cron);
    if (!cron.ok) return fail(cron.error);
    const schedule = this.armed({ ...parsed.value, id: this.scheduleId(), paused: false, createdAt: this.now(), runs: [] });
    this.store.update(bot.id, (current) => ({ ...current, schedules: [...current.schedules, schedule] }));
    this.arm();
    const next = schedule.nextRunAt === undefined ? "" : ` It next runs at ${new Date(schedule.nextRunAt).toISOString()}.`;
    return ok(`Schedule "${schedule.name}" created (id ${schedule.id}).${next}`);
  }

  private scheduleUpdate(bot: BotRecord, args: unknown): RoomToolResult {
    const parsed = parseScheduleUpdateArgs(args);
    if (!parsed.ok) return fail(parsed.error);
    const { id, ...change } = parsed.value;
    if (!bot.schedules.some((each) => each.id === id)) return fail(`There is no schedule "${id}"; bot_status lists them.`);
    if (change.cron) {
      const cron = checkCron(change.cron);
      if (!cron.ok) return fail(cron.error);
    }
    this.store.update(bot.id, (current) => ({
      ...current,
      schedules: current.schedules.map((each) => (each.id === id ? this.armed({ ...each, ...change, ...(change.cron ? { nextRunAt: undefined } : {}) }) : each)),
    }));
    this.arm();
    return ok("Schedule updated.");
  }

  // ------------------------------------------------------------ scheduler

  /** Starts the scheduler: arms every schedule, running (once) or recording
   * as missed what came due while the relay was down. */
  start(): void {
    this.started = true;
    this.arm();
  }

  stop(): void {
    this.started = false;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** The agent host came back: runs that waited for it go now. */
  onHostConnected(): void {
    this.arm();
  }

  /** A schedule with its next run computed (none while paused). */
  private armed(schedule: BotSchedule): BotSchedule {
    if (schedule.paused) {
      if (schedule.nextRunAt === undefined) return schedule;
      const { nextRunAt: _next, ...rest } = schedule;
      void _next;
      return rest;
    }
    if (schedule.nextRunAt !== undefined) return schedule;
    const next = nextRunAfter(schedule.cron, this.now(), this.options.timezone);
    return next === undefined ? schedule : { ...schedule, nextRunAt: next };
  }

  /** Looks at every schedule: fires what is due, records what was missed,
   * and sets one timer for the soonest of the rest. */
  private arm(): void {
    if (!this.started) return;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const now = this.now();
    let soonest: number | undefined;
    for (const bot of this.store.list()) {
      // Everything this pass changes on the bot is written once at the end
      // (each write rewrites the whole file and wakes every listener), as
      // edits applied to the record as it is then: a stale run recorded
      // meanwhile by `isRunning` is kept.
      const edits = new Map<string, (schedule: BotSchedule) => BotSchedule>();
      const edit = (id: string, change: (schedule: BotSchedule) => BotSchedule): void => {
        const before = edits.get(id);
        edits.set(id, before ? (schedule) => change(before(schedule)) : change);
      };
      const toFire: BotSchedule[] = [];
      let owedWaiting = false;
      for (const raw of bot.schedules) {
        const schedule = this.armed(raw);
        if (schedule !== raw) edit(raw.id, (each) => this.armed(each));
        if (schedule.paused || schedule.nextRunAt === undefined) continue;
        const decision = dueDecision(schedule.nextRunAt, now);
        if (decision === "wait") {
          soonest = Math.min(soonest ?? Infinity, schedule.nextRunAt);
          continue;
        }
        // Its agent's plan is spent: the run waits for the reset, held (its
        // time not advanced), and is looked at again then.
        if (bot.limitedUntil !== undefined && bot.limitedUntil > now) {
          soonest = Math.min(soonest ?? Infinity, bot.limitedUntil);
          continue;
        }
        // A run the limit held is owed once it passes, however late: one
        // catch-up, never one per occurrence it covered.
        const owed = decision === "missed" && bot.limitedUntil !== undefined && schedule.nextRunAt <= bot.limitedUntil;
        const due = owed ? "run" : decision;
        // A paused bot, or the last run still going: nothing to do this time.
        const skip = due === "run" && (bot.paused || this.isRunning(bot, schedule.id));
        if (due === "run" && !skip && !this.options.hostConnected()) {
          // Tried again shortly, while it is still within the grace (an
          // owed run keeps the limit standing until it gets to run).
          soonest = Math.min(soonest ?? Infinity, now + SCHEDULER_RETRY_MS);
          if (owed) owedWaiting = true;
          continue;
        }
        if (due === "run" && !skip) toFire.push(schedule);
        // A missed run is recorded; in every case the next occurrence is armed.
        if (due === "missed") {
          const missedAt = schedule.nextRunAt;
          edit(schedule.id, (each) => ({ ...each, runs: withRun(each.runs, { at: missedAt, outcome: "missed" }) }));
        }
        edit(schedule.id, (each) => this.advanced(each, now));
        const next = this.advanced(schedule, now).nextRunAt;
        if (next !== undefined) soonest = Math.min(soonest ?? Infinity, next);
      }
      // A limit is over once its time passes (the runs it held fire below):
      // cleared, so the bot reads as itself again. One still standing wakes
      // the scheduler when it ends.
      const limitOver = bot.limitedUntil !== undefined && bot.limitedUntil <= now && !owedWaiting;
      if (bot.limitedUntil !== undefined && bot.limitedUntil > now) soonest = Math.min(soonest ?? Infinity, bot.limitedUntil);
      if (edits.size > 0 || limitOver) {
        this.store.update(bot.id, (current) => {
          const { limitedUntil, ...rest } = current;
          return {
            ...rest,
            ...(limitOver || limitedUntil === undefined ? {} : { limitedUntil }),
            schedules: current.schedules.map((each) => edits.get(each.id)?.(each) ?? each),
          };
        });
      }
      for (const schedule of toFire) this.fire(this.store.get(bot.id)!, schedule);
    }
    if (soonest === undefined) return;
    const wait = Math.min(Math.max(0, soonest - now), SCHEDULER_MAX_WAIT_MS);
    this.cancelTimer = (this.options.setTimer ?? defaultTimer)(() => this.arm(), wait);
  }

  /** The schedule with its next occurrence after `from` armed. */
  private advanced(schedule: BotSchedule, from: number): BotSchedule {
    const next = nextRunAfter(schedule.cron, from, this.options.timezone);
    const { nextRunAt: _old, ...rest } = schedule;
    void _old;
    return next === undefined ? rest : { ...rest, nextRunAt: next };
  }

  private recordRun(botId: string, scheduleId: string, run: { at: number; outcome: BotRunOutcome }): void {
    this.store.update(botId, (current) => ({
      ...current,
      schedules: current.schedules.map((each) => (each.id === scheduleId ? { ...each, runs: withRun(each.runs, run) } : each)),
    }));
  }

  private fire(bot: BotRecord, schedule: BotSchedule): void {
    const key = `${bot.id}:${schedule.id}`;
    const at = this.now();
    this.running.set(key, at);
    this.store.touch(bot.id);
    this.options.sessions.getOrCreate(bot.roomId).submitBotTurn(botScheduleText(schedule.name, schedule.prompt), {
      kind: "bot_schedule",
      label: schedule.name,
      onSettled: (outcome) => {
        // A run already taken as stale was recorded then, and a newer one
        // may hold the key by now.
        if (this.running.get(key) === at) {
          this.running.delete(key);
          if (this.store.get(bot.id)?.schedules.some((each) => each.id === schedule.id)) {
            this.recordRun(bot.id, schedule.id, { at, outcome: outcome.limited ? "limited" : outcome.failed ? "failed" : outcome.silenced ? "silent" : "replied" });
          }
        }
        // Last: what it does to a limit re-arms the scheduler, which must
        // see this run as over.
        this.turnSettled(bot.id, outcome);
      },
    });
  }

  /** How any turn of the bot's own ended: a usage limit holds its schedules
 * until the agent's plan resets (when its plan usage says, else an hour); a
 * turn that went through clears a limit that was still standing. */
  private turnSettled(botId: string, outcome: { failed: boolean; limited?: boolean }): void {
    const bot = this.store.get(botId);
    if (!bot) return;
    if (outcome.limited) {
      const now = this.now();
      const resetAt = this.options.usageResetAt?.(this.options.sessionStore.getAgentId(bot.roomId));
      const until = resetAt !== undefined && resetAt > now ? resetAt : now + UNKNOWN_RESET_HOLD_MS;
      this.store.update(botId, (current) => ({ ...current, limitedUntil: until }));
      this.arm();
      return;
    }
    // Ended now rather than dropped: the scheduler still sees which runs the
    // limit held (their time is before it), fires their one catch-up, and
    // then clears it.
    if (!outcome.failed && bot.limitedUntil !== undefined && bot.limitedUntil > this.now()) {
      const now = this.now();
      this.store.update(botId, (current) => ({ ...current, limitedUntil: now }));
      this.arm();
    }
  }

  /** Whether a run of the schedule is under way, read only: one that
   * started long ago while the bot is idle does not count. Views use this;
   * they must never record anything. */
  private runIsLive(bot: BotRecord, scheduleId: string): boolean {
    const startedAt = this.running.get(`${bot.id}:${scheduleId}`);
    if (startedAt === undefined) return false;
    return this.now() - startedAt < RUN_STALE_MS || this.options.sessions.peek(bot.roomId)?.isBusy() === true;
  }

  /** Whether a run of the schedule is under way, for the scheduler and Run
   * now: a stale one (see `runIsLive`) is taken as over, recorded as
   * failed, and forgotten. */
  private isRunning(bot: BotRecord, scheduleId: string): boolean {
    if (this.runIsLive(bot, scheduleId)) return true;
    const key = `${bot.id}:${scheduleId}`;
    const startedAt = this.running.get(key);
    if (startedAt === undefined) return false;
    this.running.delete(key);
    this.recordRun(bot.id, scheduleId, { at: startedAt, outcome: "failed" });
    return false;
  }

  private scheduleId(): string {
    return `s${randomBytes(4).toString("hex")}`;
  }

  // ------------------------------------------------------------ views

  private awaitsPerson(id: string): boolean {
    return this.options.sessionStore.getPendingChoice(id) !== undefined || this.options.sessionStore.getPendingApproval(id) !== undefined;
  }

  private taskView(task: BotTask): BotTaskView {
    return {
      n: task.n,
      title: task.title,
      status: taskStatus(task, (id) => this.awaitsPerson(id)),
      ...(task.doneMeans ? { doneMeans: task.doneMeans } : {}),
      ...(task.question ? { question: task.question } : {}),
      ...(task.from ? { from: { botId: task.from.botId, name: this.store.get(task.from.botId)?.name ?? null } } : {}),
      notes: task.notes,
      workers: task.workerIds.map((agentId) => {
        const room = this.options.sessionStore.getRoom(agentId);
        return {
          agentId,
          title: this.options.sessionStore.getTitle(agentId),
          state: room ? (this.options.rooms.agentState(agentId) ?? "gone") : "gone",
          ...(room?.startedAt !== undefined ? { startedAt: room.startedAt } : {}),
        };
      }),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  summary(bot: BotRecord): BotSummary {
    const tasks = bot.tasks.map((task) => ({ task, status: taskStatus(task, (id) => this.awaitsPerson(id)) }));
    const conversationNeedsYou = this.awaitsPerson(bot.roomId);
    const workers = this.options.sessionStore.listRoomMembers(bot.roomId).filter((member) => member.room.role === "worker");
    const working = workers.filter((member) => {
      const state = this.options.rooms.agentState(member.id);
      return state === "working" || state === "queued";
    }).length;
    const latest = [...tasks].sort((a, b) => b.task.updatedAt - a.task.updatedAt)[0];
    const upcoming = bot.paused ? [] : bot.schedules.filter((each) => !each.paused && each.nextRunAt !== undefined).sort((a, b) => a.nextRunAt! - b.nextRunAt!);
    const lastRun = bot.schedules
      .flatMap((each) => each.runs)
      .sort((a, b) => b.at - a.at)
      .find((run) => run.outcome !== "missed");
    return {
      id: bot.id,
      roomId: bot.roomId,
      name: bot.name,
      mascot: bot.mascot,
      paused: bot.paused,
      firstRun: bot.firstRun,
      ...(bot.templateId ? { templateId: bot.templateId } : {}),
      needsYou: tasks.filter((each) => each.status === "needs_you").length + (conversationNeedsYou ? 1 : 0),
      working,
      busy: this.options.sessions.peek(bot.roomId)?.isBusy() ?? false,
      ...(latest ? { latestTask: { n: latest.task.n, title: latest.task.title, status: latest.status, updatedAt: latest.task.updatedAt } } : {}),
      ...(upcoming[0] ? { nextRun: { name: upcoming[0].name, at: upcoming[0].nextRunAt! } } : {}),
      lastRunFailed: lastRun?.outcome === "failed",
      ...(bot.limitedUntil !== undefined && bot.limitedUntil > this.now() ? { limitedUntil: bot.limitedUntil } : {}),
      createdAt: bot.createdAt,
      scheduleCount: bot.schedules.length,
      runs24h: this.runsInLastDay(bot),
      peer24h: this.peerSentInLastDay(bot.id),
    };
  }

  private runsInLastDay(bot: BotRecord): Record<BotRunOutcome, number> {
    const since = this.now() - DAY_MS;
    const counts: Record<BotRunOutcome, number> = { replied: 0, silent: 0, failed: 0, missed: 0, limited: 0 };
    for (const run of bot.schedules.flatMap((each) => each.runs)) if (run.at > since) counts[run.outcome]++;
    return counts;
  }

  private notePeerSent(botId: string, kind: "ask" | "handoff"): void {
    const now = this.now();
    this.peerSent.set(botId, [...(this.peerSent.get(botId) ?? []).filter((each) => each.at > now - DAY_MS), { at: now, kind }]);
  }

  private peerSentInLastDay(botId: string): { asks: number; handoffs: number } {
    const since = this.now() - DAY_MS;
    const recent = (this.peerSent.get(botId) ?? []).filter((each) => each.at > since);
    return { asks: recent.filter((each) => each.kind === "ask").length, handoffs: recent.filter((each) => each.kind === "handoff").length };
  }

  summaries(): BotSummary[] {
    return this.store
      .list()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((bot) => this.summary(bot));
  }

  view(roomId: string): BotView | undefined {
    const bot = this.store.byRoom(roomId);
    if (!bot) return undefined;
    return {
      ...this.summary(bot),
      conversationNeedsYou: this.awaitsPerson(bot.roomId),
      tasks: bot.tasks.map((task) => this.taskView(task)),
      schedules: bot.schedules.map((schedule) => ({
        id: schedule.id,
        name: schedule.name,
        cron: schedule.cron,
        prompt: schedule.prompt,
        paused: schedule.paused,
        ...(schedule.nextRunAt !== undefined && !schedule.paused ? { nextRunAt: schedule.nextRunAt } : {}),
        running: this.runIsLive(bot, schedule.id),
        runs: schedule.runs,
      })),
    };
  }

  /** The bot whose room is `roomId`, if any. */
  byRoom(roomId: string): BotRecord | undefined {
    return this.store.byRoom(roomId);
  }

  get(id: string): BotRecord | undefined {
    return this.store.get(id);
  }
}
