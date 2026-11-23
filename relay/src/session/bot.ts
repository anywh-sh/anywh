// A bot: a room that never ends, with an identity. Its principal is the
// bot's own conversation (the person talks to it there, and its schedules
// run there); its workers are the room's, unchanged. What the room does not
// have, and lives here, is the bot's identity (name, mascot), its task list
// and its schedules. Its soul and memory are plain files (botFiles.ts).
//
// Persisted per profile in `<profile>-bots.json` (botStore.ts). Whether a
// task needs the person is derived, never stored: a question the bot put on
// it, or a worker of the task waiting for the person.
//
// Pure: no I/O, so the rules are testable as tables.

/** What the bot recorded about a task. `needs_you` is not among them: it is
 * derived (see `taskStatus`). */
export type BotTaskStoredStatus = "planned" | "working" | "done" | "canceled";

/** A task as the person sees it. */
export type BotTaskStatus = BotTaskStoredStatus | "needs_you";

export interface BotTaskQuestion {
  question: string;
  options: string[];
  /** Index into `options` of the one the bot recommends, if any. */
  recommended?: number;
  askedAt: number;
}

export interface BotTaskNote {
  text: string;
  at: number;
}

export interface BotTask {
  /** Sequential per bot, from 1: how the bot and the person name the task. */
  n: number;
  title: string;
  status: BotTaskStoredStatus;
  /** What makes the task done, in one line, as the bot wrote it. */
  doneMeans?: string;
  /** The room's workers started for this task, in order. */
  workerIds: string[];
  /** A question the bot put to the person, open until answered. */
  question?: BotTaskQuestion;
  notes: BotTaskNote[];
  createdAt: number;
  updatedAt: number;
}

/** How one firing of a schedule ended. `missed`: the relay was down at the
 * time and it was too late to run it. `limited`: the agent's plan ran out
 * (a usage limit), which is neither a success nor the bot failing. */
export type BotRunOutcome = "replied" | "silent" | "failed" | "missed" | "limited";

export interface BotRun {
  at: number;
  outcome: BotRunOutcome;
}

export interface BotSchedule {
  id: string;
  name: string;
  /** Five-field cron, in the host's time zone. */
  cron: string;
  /** What the bot is asked each time it fires. */
  prompt: string;
  paused: boolean;
  createdAt: number;
  /** The next time it is due, once armed: how a restart tells a run that
   * was missed while the relay was down. */
  nextRunAt?: number;
  /** The latest runs, newest last. */
  runs: BotRun[];
}

/** The pixel characters a bot can wear, each with the tone it comes in.
 * The drawings are the client's; the relay only keeps the choice. */
export const BOT_CHARACTER_TONES = {
  bip: "sand",
  visor: "chalk",
  headset: "sage",
  quiff: "stone",
  helmet: "rose",
  cyclops: "cloud",
  screen: "slate",
  specs: "olive",
  chip: "sage",
  propeller: "chalk",
} as const;
export type BotCharacter = keyof typeof BOT_CHARACTER_TONES;
export const BOT_TONES = ["chalk", "sand", "sage", "olive", "rose", "cloud", "slate", "stone"] as const;
export type BotTone = (typeof BOT_TONES)[number];

export interface BotMascot {
  character: BotCharacter;
  tone: BotTone;
}

export function isBotCharacter(value: unknown): value is BotCharacter {
  return typeof value === "string" && Object.hasOwn(BOT_CHARACTER_TONES, value);
}

export function isBotTone(value: unknown): value is BotTone {
  return typeof value === "string" && (BOT_TONES as readonly string[]).includes(value);
}

export function isBotMascot(value: unknown): value is BotMascot {
  return isRecord(value) && isBotCharacter(value.character) && isBotTone(value.tone);
}

/** A mascot nobody picked (a bot made over HTTP without one): a character
 * from the name, so two such bots rarely look alike, in its own tone. */
export function defaultMascot(name: string): BotMascot {
  let h = 0x811c9dc5;
  for (const char of name.trim().toLowerCase()) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  const characters = Object.keys(BOT_CHARACTER_TONES) as BotCharacter[];
  const character = characters[(h >>> 0) % characters.length];
  return { character, tone: BOT_CHARACTER_TONES[character] };
}

export interface BotRecord {
  id: string;
  name: string;
  mascot: BotMascot;
  /** The room (= its principal's session id). */
  roomId: string;
  /** The template it was made from, if any. */
  templateId?: string;
  /** No schedule fires while paused. */
  paused: boolean;
  /** Until the bot writes its own soul (`set_soul`). */
  firstRun: boolean;
  /** Its agent hit a usage limit: no schedule fires before this, and the
   * runs it held fire once it passes. */
  limitedUntil?: number;
  createdAt: number;
  /** The next task number. */
  nextTaskN: number;
  tasks: BotTask[];
  schedules: BotSchedule[];
}

export const BOT_NAME_MAX = 40;
export const BOT_TASK_TITLE_MAX = 200;
export const BOT_TASK_NOTE_MAX = 1000;
export const BOT_TASK_NOTES_KEPT = 30;
/** Closed tasks kept per bot; older ones are dropped. */
export const BOT_CLOSED_TASKS_KEPT = 100;
export const BOT_OPEN_TASKS_MAX = 50;
export const BOT_QUESTION_MAX = 500;
export const BOT_OPTION_MAX = 200;
export const BOT_OPTIONS_MAX = 6;
export const BOT_SCHEDULES_MAX = 20;
export const BOT_SCHEDULE_NAME_MAX = 80;
export const BOT_SCHEDULE_PROMPT_MAX = 4000;
export const BOT_RUNS_KEPT = 20;

const STORED_STATUSES: ReadonlySet<string> = new Set(["planned", "working", "done", "canceled"]);
const RUN_OUTCOMES: ReadonlySet<string> = new Set(["replied", "silent", "failed", "missed", "limited"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isQuestion(value: unknown): value is BotTaskQuestion {
  return (
    isRecord(value) &&
    typeof value.question === "string" &&
    isStringList(value.options) &&
    (value.recommended === undefined || (Number.isInteger(value.recommended) && (value.recommended as number) >= 0)) &&
    isTimestamp(value.askedAt)
  );
}

function isTask(value: unknown): value is BotTask {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.n) &&
    (value.n as number) > 0 &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    STORED_STATUSES.has(value.status) &&
    (value.doneMeans === undefined || typeof value.doneMeans === "string") &&
    isStringList(value.workerIds) &&
    (value.question === undefined || isQuestion(value.question)) &&
    Array.isArray(value.notes) &&
    value.notes.every((note) => isRecord(note) && typeof note.text === "string" && isTimestamp(note.at)) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

function isSchedule(value: unknown): value is BotSchedule {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.name === "string" &&
    typeof value.cron === "string" &&
    typeof value.prompt === "string" &&
    typeof value.paused === "boolean" &&
    isTimestamp(value.createdAt) &&
    (value.nextRunAt === undefined || isTimestamp(value.nextRunAt)) &&
    Array.isArray(value.runs) &&
    value.runs.every((run) => isRecord(run) && isTimestamp(run.at) && typeof run.outcome === "string" && RUN_OUTCOMES.has(run.outcome))
  );
}

/** Runtime check for what the bots file holds: a hand-edited, truncated or
 * future-schema record never reaches the bot logic. */
export function isBotRecord(value: unknown): value is BotRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.name === "string" &&
    isBotMascot(value.mascot) &&
    typeof value.roomId === "string" &&
    value.roomId !== "" &&
    (value.templateId === undefined || typeof value.templateId === "string") &&
    (value.limitedUntil === undefined || isTimestamp(value.limitedUntil)) &&
    typeof value.paused === "boolean" &&
    typeof value.firstRun === "boolean" &&
    isTimestamp(value.createdAt) &&
    Number.isInteger(value.nextTaskN) &&
    (value.nextTaskN as number) > 0 &&
    Array.isArray(value.tasks) &&
    value.tasks.every(isTask) &&
    Array.isArray(value.schedules) &&
    value.schedules.every(isSchedule)
  );
}

export function isClosed(status: BotTaskStatus): boolean {
  return status === "done" || status === "canceled";
}

/** The task's status as the person sees it: one with an open question, or a
 * worker of it waiting for the person, needs them (unless it is closed). */
export function taskStatus(task: BotTask, workerAwaitsPerson: (workerId: string) => boolean): BotTaskStatus {
  if (isClosed(task.status)) return task.status;
  if (task.question || task.workerIds.some(workerAwaitsPerson)) return "needs_you";
  return task.status;
}

/** Drops the oldest closed tasks beyond `BOT_CLOSED_TASKS_KEPT`, keeping the
 * order of the rest. */
export function pruneTasks(tasks: readonly BotTask[]): BotTask[] {
  const closed = tasks.filter((task) => isClosed(task.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  const dropped = new Set(closed.slice(BOT_CLOSED_TASKS_KEPT).map((task) => task.n));
  return tasks.filter((task) => !dropped.has(task.n));
}

/** Appends a run, keeping the latest `BOT_RUNS_KEPT`. */
export function withRun(runs: readonly BotRun[], run: BotRun): BotRun[] {
  return [...runs, run].slice(-BOT_RUNS_KEPT);
}

/** Appends a note, keeping the latest `BOT_TASK_NOTES_KEPT`. */
export function withNote(notes: readonly BotTaskNote[], note: BotTaskNote): BotTaskNote[] {
  return [...notes, note].slice(-BOT_TASK_NOTES_KEPT);
}

/** A bot name as the person typed it: trimmed, single-line, bounded;
 * `undefined` when there is nothing left. */
export function cleanBotName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.replace(/\s+/g, " ").trim();
  if (name === "" || name.length > BOT_NAME_MAX) return undefined;
  return name;
}
