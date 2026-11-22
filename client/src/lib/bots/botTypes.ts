// What the relay says about bots (its `session/bot.ts` and
// `session/botManager.ts`). The shapes mirror the relay's by convention, not
// by import — same as the rest of `lib/relay`.
import type { RoomAgentState } from "@/lib/relay/roomClient";
import type { MascotChoice } from "@/lib/bots/mascot";

/** `needs_you` is derived by the relay: an open question on the task, or a
 * worker of it waiting for the person. */
export type BotTaskStatus = "planned" | "working" | "needs_you" | "done" | "canceled";

export interface BotTaskQuestion {
  question: string;
  options: string[];
  recommended?: number;
  askedAt: number;
}

export interface BotWorkerView {
  agentId: string;
  title: string | null;
  state: RoomAgentState | "gone";
  startedAt?: number;
}

export interface BotTask {
  n: number;
  title: string;
  status: BotTaskStatus;
  doneMeans?: string;
  question?: BotTaskQuestion;
  notes: { text: string; at: number }[];
  workers: BotWorkerView[];
  createdAt: number;
  updatedAt: number;
}

export type BotRunOutcome = "replied" | "silent" | "failed" | "missed";

export interface BotSchedule {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  paused: boolean;
  nextRunAt?: number;
  running: boolean;
  runs: { at: number; outcome: BotRunOutcome }[];
}

/** A bot as the sidebar lists it. */
export interface BotSummary {
  id: string;
  roomId: string;
  name: string;
  mascot: MascotChoice;
  paused: boolean;
  firstRun: boolean;
  templateId?: string;
  needsYou: number;
  working: number;
  busy: boolean;
  latestTask?: { n: number; title: string; status: BotTaskStatus; updatedAt: number };
  nextRun?: { name: string; at: number };
  lastRunFailed: boolean;
  createdAt: number;
}

/** A bot as its room's channel sends it. */
export interface BotView extends BotSummary {
  conversationNeedsYou: boolean;
  tasks: BotTask[];
  schedules: BotSchedule[];
}

export type MemoryKind = "rule" | "preference" | "fact";

export interface MemoryLine {
  index: number;
  text: string;
  kind?: MemoryKind;
  date?: string;
  source?: string;
  raw: string;
}

/** The order the task list groups tasks in: what needs the person first. */
export const TASK_GROUPS: readonly BotTaskStatus[] = ["needs_you", "working", "planned", "done"];

/** A task's group: canceled ones live with the done ones. */
export function taskGroup(status: BotTaskStatus): BotTaskStatus {
  return status === "canceled" ? "done" : status;
}

export function isBotSummary(value: unknown): value is BotSummary {
  if (typeof value !== "object" || value === null) return false;
  const bot = value as Record<string, unknown>;
  return typeof bot.id === "string" && typeof bot.roomId === "string" && typeof bot.name === "string" && typeof bot.mascot === "object" && bot.mascot !== null && typeof bot.needsYou === "number";
}

export function isClosedTask(status: BotTaskStatus): boolean {
  return status === "done" || status === "canceled";
}
