// What bots do: creating one (a room plus an identity), answering the tools
// only bots have, keeping their task lists, firing their schedules, and
// describing them to clients. The room machinery (delegation, workers,
// reports, worktrees) is the room's, unchanged; this file only adds what a
// room that never ends needs on top (see bot.ts).
import { randomBytes, randomUUID } from "node:crypto";
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
import { memoryForPrompt, type BotFiles, type MemoryLine } from "./botFiles.js";
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
  submitBotTurn(text: string, turn: { kind: "bot_schedule" | "bot_note"; label: string; onSettled?: (outcome: { silenced: boolean; failed: boolean; limited?: boolean }) => void }): void;
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
    if (typeof input.soul !== "string" || input.soul.trim() === "" || input.soul.length > 8000) return { ok: false, status: 400, error: "soul must be a non-empty string" };
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
    const room = this.options.rooms.createRoom({ agentId: input.agentId, model: input.model, effort: input.effort, permissionMode: input.permissionMode, cwd: input.cwd, title: name, roomId });
    if (!room.ok) {
      this.store.delete(id);
      this.options.files.remove(id);
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
    if (input.soul !== undefined && (typeof input.soul !== "string" || input.soul.trim() === "" || input.soul.length > 8000)) return { ok: false, status: 400, error: "soul must be a non-empty string" };
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
    return bot.firstRun ? `${BOT_FIRST_RUN_NOTE}\n\n${clock}` : clock;
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
    if (!bot.tasks.some((task) => task.n === n)) return fail(`There is no task #${n}.`);
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
      for (const raw of bot.schedules) {
        const schedule = this.armed(raw);
        if (schedule !== raw) this.store.update(bot.id, (current) => ({ ...current, schedules: current.schedules.map((each) => (each.id === raw.id ? schedule : each)) }));
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
        if (due === "run" && (bot.paused || this.isRunning(bot, schedule.id))) {
          // Nothing to do this time (a paused bot, or the last run still
          // going): the next occurrence is armed.
          this.advance(bot.id, schedule.id, now);
        } else if (due === "run" && !this.options.hostConnected()) {
          // Tried again shortly, while it is still within the grace.
          soonest = Math.min(soonest ?? Infinity, now + SCHEDULER_RETRY_MS);
          continue;
        } else if (due === "run") {
          this.advance(bot.id, schedule.id, now);
          this.fire(this.store.get(bot.id)!, schedule);
        } else {
          this.recordRun(bot.id, schedule.id, { at: schedule.nextRunAt, outcome: "missed" });
          this.advance(bot.id, schedule.id, now);
        }
        const next = this.store.get(bot.id)?.schedules.find((each) => each.id === schedule.id)?.nextRunAt;
        if (next !== undefined) soonest = Math.min(soonest ?? Infinity, next);
      }
      // A limit is over once its time passes (the runs it held fired just
      // above): cleared, so the bot reads as itself again. One still
      // standing wakes the scheduler when it ends.
      if (bot.limitedUntil !== undefined && bot.limitedUntil <= now) {
        this.store.update(bot.id, (current) => {
          const { limitedUntil: _over, ...rest } = current;
          void _over;
          return rest;
        });
      } else if (bot.limitedUntil !== undefined) {
        soonest = Math.min(soonest ?? Infinity, bot.limitedUntil);
      }
    }
    if (soonest === undefined) return;
    const wait = Math.min(Math.max(0, soonest - now), SCHEDULER_MAX_WAIT_MS);
    this.cancelTimer = (this.options.setTimer ?? defaultTimer)(() => this.arm(), wait);
  }

  private advance(botId: string, scheduleId: string, from: number): void {
    this.store.update(botId, (current) => ({
      ...current,
      schedules: current.schedules.map((each) => {
        if (each.id !== scheduleId) return each;
        const next = nextRunAfter(each.cron, from, this.options.timezone);
        const { nextRunAt: _old, ...rest } = each;
        void _old;
        return next === undefined ? rest : { ...rest, nextRunAt: next };
      }),
    }));
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

  /** Whether a run of the schedule is under way. One that started long ago
   * while the bot is idle is taken as over and forgotten. */
  private isRunning(bot: BotRecord, scheduleId: string): boolean {
    const key = `${bot.id}:${scheduleId}`;
    const startedAt = this.running.get(key);
    if (startedAt === undefined) return false;
    if (this.now() - startedAt < RUN_STALE_MS || this.options.sessions.peek(bot.roomId)?.isBusy() === true) return true;
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
    };
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
        running: this.isRunning(bot, schedule.id),
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
