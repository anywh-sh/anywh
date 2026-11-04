// A worker's native subagents on the room's canvas: which of them show as
// mini-cards under their parent, and where those go. A mini-card is never
// stored with the canvas: its place follows from its parent's, a band right
// under the parent's card. Pure.
import type { RoomAgent, RoomSubtaskView } from "@/lib/relay/roomClient";
import { cardStatus, type CardTone } from "@/lib/sala/agentCard";
import type { Rect } from "@/lib/sala/camera";

export const MINI_W = 192;
export const MINI_H = 84;
/** Between two mini-cards, side by side and from one row to the next. */
export const MINI_GAP = 12;
export const MINI_PER_ROW = 3;
/** Most mini-cards under one parent, the "+N" one included. */
export const MINI_MAX = 6;
/** From the bottom of the parent's card to the top of its band. */
export const SUB_DROP = 48;

export interface VisibleSubtasks {
  /** Oldest first, a subtask keeping its place as its status changes. */
  shown: RoomSubtaskView[];
  /** How many more there are, shown as a single "+N" mini-card. */
  hidden: number;
}

const NONE: VisibleSubtasks = { shown: [], hidden: 0 };
const ALIVE: ReadonlySet<CardTone> = new Set(["run", "wait", "start"]);

/**
 * The mini-cards of `agent`. While the agent is at it (running, waiting for
 * the person, starting) or any subtask still runs: the subtasks of its
 * present run, every running one whatever its age. Once the agent is over
 * and nothing runs, none: the history is in its panel. Past `MINI_MAX`, the
 * oldest finished ones give way to a "+N" mini-card.
 */
export function visibleSubtasks(agent: Pick<RoomAgent, "state" | "needsYou" | "role" | "startedAt" | "subtasks">): VisibleSubtasks {
  const all = agent.subtasks ?? [];
  if (all.length === 0) return NONE;
  const anyRunning = all.some((subtask) => subtask.status === "running");
  if (!anyRunning && !ALIVE.has(cardStatus(agent).tone)) return NONE;
  const started = agent.startedAt;
  const ofRun = all.filter((subtask) => subtask.status === "running" || started === undefined || subtask.startedAt >= started).sort((a, b) => a.startedAt - b.startedAt);
  if (ofRun.length <= MINI_MAX) return { shown: ofRun, hidden: 0 };
  const room = MINI_MAX - 1;
  const running = ofRun.filter((subtask) => subtask.status === "running");
  const finished = ofRun.filter((subtask) => subtask.status !== "running");
  const kept = new Set([...running.slice(-room), ...finished.slice(-Math.max(0, room - running.length))]);
  const shown = ofRun.filter((subtask) => kept.has(subtask));
  return { shown, hidden: ofRun.length - shown.length };
}

/** How many mini-cards `agent` has, the "+N" one included. */
export function subtaskTiles(agent: Parameters<typeof visibleSubtasks>[0]): number {
  const { shown, hidden } = visibleSubtasks(agent);
  return shown.length + (hidden > 0 ? 1 : 0);
}

function bandSize(n: number): { w: number; h: number } {
  const cols = Math.min(n, MINI_PER_ROW);
  const rows = Math.ceil(n / MINI_PER_ROW);
  return { w: cols * MINI_W + (cols - 1) * MINI_GAP, h: rows * MINI_H + (rows - 1) * MINI_GAP };
}

/** The box `n` mini-cards take under `parent`: centred under it, its top
 * `SUB_DROP` below the parent's card. */
export function subtaskBand(parent: Rect, n: number): Rect | undefined {
  if (n <= 0) return undefined;
  const { w, h } = bandSize(n);
  return { x: parent.x + parent.w / 2 - w / 2, y: parent.y + parent.h + SUB_DROP, w, h };
}

/** Each mini-card's box, in order: rows of `MINI_PER_ROW` from the band's
 * left edge. */
export function subtaskRects(parent: Rect, n: number): Rect[] {
  const band = subtaskBand(parent, n);
  if (!band) return [];
  return Array.from({ length: n }, (_, i) => ({
    x: band.x + (i % MINI_PER_ROW) * (MINI_W + MINI_GAP),
    y: band.y + Math.floor(i / MINI_PER_ROW) * (MINI_H + MINI_GAP),
    w: MINI_W,
    h: MINI_H,
  }));
}

/** How far a band reaches below its parent's card: the drop and the band. */
export function bandDepth(n: number): number {
  return n > 0 ? SUB_DROP + bandSize(n).h : 0;
}

/** The width a band takes, for laying out what sits beside its parent. */
export function bandWidth(n: number): number {
  return n > 0 ? bandSize(n).w : 0;
}

/** A card together with its band: what it takes on the canvas. */
export function footprint(card: Rect, band: Rect | undefined): Rect {
  if (!band) return card;
  const x = Math.min(card.x, band.x);
  const y = Math.min(card.y, band.y);
  return { x, y, w: Math.max(card.x + card.w, band.x + band.w) - x, h: Math.max(card.y + card.h, band.y + band.h) - y };
}

/** The tone of the link to a mini-card, from the same palette as the links
 * between agents. */
export function subtaskTone(subtask: Pick<RoomSubtaskView, "status" | "needsYou">): "run" | "wait" | "done" | "stop" {
  if (subtask.status === "running") return subtask.needsYou ? "wait" : "run";
  return subtask.status === "completed" ? "done" : "stop";
}
