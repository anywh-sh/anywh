// What a room's card says about its agent, derived from the room channel's
// view of it: which status label, which line of activity, which time. Pure;
// the words themselves come from the dictionary at the call site.
import type { RoomAction, RoomAgent, RoomAgentState } from "@/lib/relay/roomClient";

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

/** One line of a card's log: the terminal-like body under its title bar. */
export interface CardLine {
  /** A report's own words, or `null` for the agent's activity, which the
   * card words from `cardActivity`. */
  text: string | null;
  /** The action this line reports, which the card words as the conversation's
   * "Working" block would (`Reading socket.ts`). */
  action?: { verb: RoomAction["verb"]; target?: string; running: boolean };
  /** `now` is what the agent is doing at this moment; `ask` waits for the
   * person; `past` and `quiet` are spent. */
  tone: "past" | "now" | "ask" | "fail" | "block" | "quiet";
  /** Ms into the agent's run the line belongs to; `live` counts up from
   * `startedAt`. Absent when the relay never said when the agent started. */
  at?: number | "live";
}

/** How many lines a card's log has room for. */
export const CARD_LINES = 3;

/** The non-empty lines of a report, each cut to a line a card can hold. */
function reportLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => firstLine(l));
}

/** The agent's actions in its present run, oldest first and at most as many
 * as a card has lines: what an older turn did is not part of this run. */
function runActions(agent: RoomAgent): RoomAction[] {
  const started = agent.startedAt;
  return (agent.activity ?? []).filter((a) => started === undefined || a.startedAt >= started).slice(-CARD_LINES);
}

/**
 * The lines a card's log shows, oldest first, the newest always last. While
 * the agent works, each line is one thing it did, as the relay saw it, timed
 * from the start of the run: a finished action by when it ended, the one in
 * progress counting live. A finished agent shows its report instead; one
 * that waits for the person ends on the question, above what it did.
 */
export function cardLines(agent: RoomAgent, status: CardStatus): CardLine[] {
  const started = agent.startedAt;
  const since = (at: number | undefined): number | undefined => (at !== undefined && started !== undefined && at >= started ? at - started : undefined);
  const report = agent.report ? reportLines(agent.report.summary) : [];
  const reportAt = since(agent.report?.at);
  const finished = status.tone === "done" || status.tone === "fail" || status.tone === "block";

  if (finished && report.length > 0) {
    const head: CardLine["tone"] = status.tone === "fail" ? "fail" : status.tone === "block" ? "block" : "past";
    return report.slice(0, CARD_LINES).map((text, i) => ({ text, tone: i === 0 ? head : "past", ...(i === 0 && reportAt !== undefined ? { at: reportAt } : {}) }));
  }

  const actions = runActions(agent);
  const running = status.tone === "run";
  const waiting = status.tone === "wait";
  const actionLines = (list: RoomAction[], lastIsNow: boolean): CardLine[] =>
    list.map((a, i) => {
      const now = lastIsNow && i === list.length - 1;
      const live = a.endedAt === undefined && now;
      const at = live ? ("live" as const) : since(a.endedAt ?? a.startedAt);
      return {
        text: null,
        tone: a.failed ? "fail" : now ? "now" : "past",
        action: { verb: a.verb, ...(a.target !== undefined ? { target: a.target } : {}), running: live },
        ...(at !== undefined && !(live && started === undefined) ? { at } : {}),
      };
    });

  if (running && actions.length > 0) return actionLines(actions, true);

  let tail: CardLine;
  if (running) tail = { text: null, tone: "now", ...(started !== undefined ? { at: "live" as const } : {}) };
  else if (waiting) {
    // What it asks, in its own words when the relay sent them.
    const needs = agent.needsYou[0];
    const at = since(needs?.askedAt);
    tail = { text: needs?.question ?? null, tone: "ask", ...(at !== undefined ? { at } : {}) };
  } else tail = { text: null, tone: status.tone === "fail" ? "fail" : status.tone === "block" ? "block" : "quiet" };
  // What it did before asking, or a report from an earlier turn, stays above.
  const before: CardLine[] = finished
    ? []
    : waiting && actions.length > 0
      ? actionLines(actions.slice(-(CARD_LINES - 1)), false)
      : report.slice(0, CARD_LINES - 1).map((text) => ({ text, tone: "past" }));
  return [...before, tail];
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
