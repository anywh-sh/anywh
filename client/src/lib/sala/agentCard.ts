// What a room's card says about its agent, derived from the room channel's
// view of it: which status label, which line of activity, which time. Pure;
// the words themselves come from the dictionary at the call site.
import type { RoomAgent, RoomAgentState } from "@/lib/relay/roomClient";

/** The visual language of a card's status label (HANDOFF's status table,
 * plus the two the design had not drawn yet: failed and blocked). */
export type CardTone = "run" | "start" | "wait" | "done" | "stop" | "idle" | "fail" | "block";

export interface CardStatus {
  tone: CardTone;
  /** Key under `dict.sala.status`. */
  label: "running" | "starting" | "yourTurn" | "done" | "stopped" | "idle" | "failed" | "blocked";
}

/** The label an agent's card wears. What waits for the person wins over
 * anything but a stop: an agent can have asked about something and gone on
 * working, and the person still has to look. */
export function cardStatus(agent: Pick<RoomAgent, "state" | "needsYou"> & { role?: RoomAgent["role"] }, liveWorkers = 0): CardStatus {
  if (agent.state === "stopped") return { tone: "stop", label: "stopped" };
  if (agent.needsYou.length > 0 || agent.state === "awaiting_user") return { tone: "wait", label: "yourTurn" };
  // The principal's own turn ends as soon as it has delegated; while its
  // workers are at it, the room's head is plainly running, not waiting.
  if (agent.role === "principal" && (agent.state === "waiting" || agent.state === "done") && liveWorkers > 0) return { tone: "run", label: "running" };
  switch (agent.state) {
    case "working":
      return { tone: "run", label: "running" };
    case "queued":
      return { tone: "start", label: "starting" };
    case "waiting":
      return { tone: "idle", label: "idle" };
    case "done":
      return { tone: "done", label: "done" };
    case "failed":
      return { tone: "fail", label: "failed" };
    case "blocked":
      return { tone: "block", label: "blocked" };
  }
}

/** What the line under the title says, as data the component words. */
export type CardActivity =
  | { kind: "coordinating"; agents: number }
  | { kind: "working"; subtasks: number }
  | { kind: "needsApproval"; count: number }
  | { kind: "needsAnswer"; count: number }
  | { kind: "report"; text: string }
  | { kind: "queued"; messages: number }
  | { kind: "idle" }
  | { kind: "stopped" };

/** First line of a report, cut to something a card line can hold. */
export function firstLine(text: string, max = 140): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function cardActivity(agent: RoomAgent, workers: number, liveWorkers = 0): CardActivity {
  const needs = agent.needsYou[0];
  if (agent.state === "stopped") return { kind: "stopped" };
  if (needs) return needs.kind === "approval" ? { kind: "needsApproval", count: needs.count } : { kind: "needsAnswer", count: needs.count };
  if (agent.state === "working" || (agent.role === "principal" && liveWorkers > 0)) {
    if (agent.role === "principal" && workers > 0) return { kind: "coordinating", agents: workers };
    return { kind: "working", subtasks: agent.subtasksRunning };
  }
  if (agent.state === "queued") return { kind: "queued", messages: agent.queuedMessages };
  if (agent.state === "done" || agent.state === "failed" || agent.state === "blocked") {
    return agent.report ? { kind: "report", text: firstLine(agent.report.summary) } : { kind: "idle" };
  }
  if (agent.role === "principal" && workers > 0) return { kind: "coordinating", agents: workers };
  return { kind: "idle" };
}

/** What the time under the card counts from, and the words for it. */
export type CardClock = {
  kind: "running" | "waiting" | "done" | "failed" | "blocked" | "stopped" | "starting" | "none";
  since: number;
  /** For a finished agent whose start the relay knows: how long it ran, a
   * fixed span rather than a count from `since`. */
  took?: number;
};

/**
 * The instant a card's clock counts from, when it is knowable: a question's
 * own `askedAt`, a report's arrival, or else when this screen first saw the
 * agent in its state (`observedSince`). A running agent counts from the
 * relay's `startedAt` when it sent one, and a finished one shows how long it ran.
 */
export function cardClock(agent: RoomAgent, observedSince: number, liveWorkers = 0): CardClock {
  const status = cardStatus(agent, liveWorkers);
  const needs = agent.needsYou[0];
  if (status.tone === "wait") return { kind: "waiting", since: needs?.askedAt ?? observedSince };
  if (status.tone === "run") return { kind: "running", since: agent.startedAt ?? observedSince };
  if (status.tone === "start") return { kind: "starting", since: observedSince };
  if (status.tone === "idle") return { kind: "none", since: observedSince };
  if (status.tone === "stop") return { kind: "stopped", since: observedSince };
  const kind = status.tone === "done" ? "done" : status.tone === "fail" ? "failed" : "blocked";
  const at = agent.report?.at ?? observedSince;
  return { kind, since: at, ...(agent.startedAt !== undefined && agent.report && agent.report.at >= agent.startedAt ? { took: agent.report.at - agent.startedAt } : {}) };
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return `${h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}` : String(m)}:${String(s).padStart(2, "0")}`;
}

/** Remembers when each agent was first seen in its present state, so a
 * clock can count from there. Returns the same map when nothing changed. */
export function trackStateSince(
  previous: ReadonlyMap<string, { state: RoomAgentState; since: number }>,
  agents: readonly Pick<RoomAgent, "agentId" | "state">[],
  now: number,
): Map<string, { state: RoomAgentState; since: number }> {
  const next = new Map<string, { state: RoomAgentState; since: number }>();
  for (const agent of agents) {
    const before = previous.get(agent.agentId);
    next.set(agent.agentId, before && before.state === agent.state ? before : { state: agent.state, since: now });
  }
  return next;
}

/** The two-letter tile of an agent's runtime. */
export function runtimeTile(runtime: string): string {
  if (runtime === "claude") return "CC";
  if (runtime === "codex") return "CX";
  return runtime.slice(0, 2).toUpperCase();
}

/** How many segments the card's progress bar draws, and how many are lit.
 * The relay reports no progress, so the bar is honest about it: lit only for
 * an agent that finished. */
export const PROGRESS_SEGMENTS = 14;

export function progressSegments(tone: CardTone): { lit: number; live: boolean } {
  if (tone === "done") return { lit: PROGRESS_SEGMENTS, live: false };
  if (tone === "run") return { lit: 0, live: true };
  return { lit: 0, live: false };
}
