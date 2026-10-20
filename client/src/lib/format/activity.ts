import type { Dictionary } from "@/i18n";
import type { LogEntry, ToolCallEntry } from "@/hooks/relay/useMessageLog";

type ActivityDict = Dictionary["chat"]["activity"];

type ThinkingEntry = Extract<LogEntry, { kind: "thinking" }>;
type TextEntry = Extract<LogEntry, { kind: "text" }>;

/** What a target chip names; decides its icon and whether it is set in mono. */
export type WorkTargetKind = "file" | "command" | "query" | "domain" | "app" | "other";

/** One thing a step acted on, drawn as a chip. `full` is the untruncated
 * text (the whole path, the whole command) for the chip's tooltip and for
 * opening a file; `callId` is the call it came from. */
export interface WorkTarget {
  callId: string;
  kind: WorkTargetKind;
  label: string;
  full: string;
  diff?: { added: number; removed: number };
}

/** One line of a turn's timeline: a bit of reasoning, or a run of calls that
 * did the same kind of thing (several reads in a row are one "Read"). */
export type WorkStep = { kind: "think"; id: string; text: string; running: boolean } | { kind: "tool"; id: string; verb: VerbKey; calls: ToolCallEntry[]; running: boolean; failed: boolean };

/** Everything the agent did in a turn before its final answer — reasoning,
 * interim remarks and tool calls — as one block with one clock. */
export interface WorkItem {
  kind: "work";
  /** The turn's first entry; stable while the block grows, so its open state
   * and its place in the virtualized list survive. */
  id: string;
  steps: WorkStep[];
  /** The turn is still going and this is its latest block. */
  running: boolean;
  /** The turn ended by a stop or an error, not by finishing. */
  interrupted: boolean;
  /** Calls that failed; a retry that worked does not take its failure back. */
  failed: number;
  startedAt?: number;
  /** Set once the block stopped running and every timestamp is known. */
  endedAt?: number;
  /** Start to end of the block's own timestamps; else what the relay said the
   * whole turn took (an older replay carries no timestamps). */
  durationMs?: number;
}

/** A row of the message log after grouping: one entry as it is, or the work
 * of a turn drawn as one block. */
export type TimelineItem = { kind: "single"; entry: LogEntry } | WorkItem;

/** Whether a call is part of the flowing activity, as opposed to a plan,
 * which keeps a card of its own (a checklist, not an action), or a delegated
 * task — see `isTaskShown`. */
export function isActivityCall(entry: LogEntry): entry is ToolCallEntry {
  return entry.kind === "tool-call" && entry.plan === undefined && entry.toolKind !== "task";
}

function isTaskCall(entry: LogEntry): entry is ToolCallEntry {
  return entry.kind === "tool-call" && entry.toolKind === "task";
}

/**
 * Whether a delegated task is drawn in the log. The subagent it spawns has a
 * card of its own at the end of the conversation (`LaunchedInBackground`), and
 * drawing the call too showed one agent twice — but that card only exists
 * while the subagent runs, and only for a call the CLI reported a subagent
 * for. So the call stays on screen exactly when nothing else tells its story:
 * it failed (a spawn error such as an unusable `isolation` has no subagent at
 * all, and its message is the only explanation), or it ended without the CLI
 * ever reporting a subagent for it. While it runs, or once it ended well with
 * a subagent behind it, the subagent card is the one representation — the
 * call's own result is then just the "launched" acknowledgement, not a report.
 */
function isTaskShown(call: ToolCallEntry, spawned: ReadonlySet<string>): boolean {
  if (!call.done) return false;
  if (call.isError && !call.aborted) return true;
  return call.toolUseId === undefined || !spawned.has(call.toolUseId);
}

interface TurnEnd {
  closed: boolean;
  interrupted: boolean;
  durationMs?: number;
}

/** For each entry, how its turn ends after it: still open, finished, or cut
 * short by a stop or an error — one backward pass, so grouping stays linear. */
function turnEnds(entries: LogEntry[]): TurnEnd[] {
  const ends: TurnEnd[] = new Array<TurnEnd>(entries.length);
  let after: TurnEnd = { closed: false, interrupted: false };
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    ends[index] = after;
    const entry = entries[index];
    if (entry.kind === "turn-footer") after = { closed: true, interrupted: false, ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}) };
    else if (entry.kind === "user") after = { closed: true, interrupted: false };
    else if (entry.kind === "stopped" || entry.kind === "error") after = { ...after, closed: true, interrupted: true };
  }
  return ends;
}

type WorkSource = ThinkingEntry | ToolCallEntry | TextEntry;

function buildSteps(sources: WorkSource[]): WorkStep[] {
  const steps: WorkStep[] = [];
  for (const source of sources) {
    if (source.kind === "tool-call") {
      const verb = verbKey(source);
      const last = steps[steps.length - 1];
      if (last?.kind === "tool" && last.verb === verb) {
        last.calls.push(source);
        last.running = last.running || !source.done;
        last.failed = last.failed || (source.isError && !source.aborted);
        continue;
      }
      steps.push({ kind: "tool", id: source.id, verb, calls: [source], running: !source.done, failed: source.isError && !source.aborted });
      continue;
    }
    // Reasoning with nothing to say is not a step: the block's clock already
    // counts its time, and a line that says nothing is noise on a timeline.
    if (source.text.trim() === "") continue;
    steps.push({ kind: "think", id: source.id, text: source.text.trim(), running: source.kind === "thinking" && source.running });
  }
  return steps;
}

function buildWork(sources: WorkSource[], end: TurnEnd): WorkItem {
  const starts: number[] = [];
  const ends: number[] = [];
  let open = false;
  let failed = 0;
  for (const source of sources) {
    if (source.kind === "text") continue;
    if (source.startedAt !== undefined) starts.push(source.startedAt);
    if (source.endedAt !== undefined) ends.push(source.endedAt);
    if (source.kind === "thinking" ? source.running : !source.done) open = true;
    if (source.kind === "tool-call" && source.isError && !source.aborted) failed += 1;
  }
  const startedAt = starts.length > 0 ? Math.min(...starts) : undefined;
  const endedAt = ends.length > 0 && !open ? Math.max(...ends) : undefined;
  const measured = startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : undefined;
  return {
    kind: "work",
    id: sources[0].id,
    steps: buildSteps(sources),
    running: !end.closed,
    interrupted: end.interrupted,
    failed,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(measured !== undefined ? { durationMs: measured } : end.durationMs !== undefined && end.closed ? { durationMs: end.durationMs } : {}),
  };
}

/**
 * Groups the log for display. The work of a turn — its reasoning, its tool
 * calls, and any remark the agent made on the way ("let me read X first") —
 * is one block; only the answer, the last text with nothing after it, stands
 * outside. A text that more activity follows is a step, not the answer.
 *
 * A plan, a delegated task that is shown, an error, a stop or a note each end
 * the block like any card does, so the turn reads in order around them.
 * Adjacency in the log, not turn boundaries, is the rule: it reads the same
 * live and on replay, without a concept the wire doesn't carry.
 *
 * `spawned` is the `toolUseId`s the CLI reported a subagent for. A task that
 * isn't shown (`isTaskShown`) is left out — it neither joins nor splits a
 * block.
 */
export function buildTimeline(entries: LogEntry[], spawned: ReadonlySet<string> = new Set()): TimelineItem[] {
  const ends = turnEnds(entries);
  const items: TimelineItem[] = [];
  let run: WorkSource[] = [];
  let runEnd: TurnEnd = { closed: false, interrupted: false };
  // Texts wait here until the next entry says whether they were the answer:
  // activity after them makes them steps of the block, anything else makes
  // them stand on their own after it.
  let held: TextEntry[] = [];
  const settle = (): void => {
    if (run.length > 0) items.push(buildWork(run, runEnd));
    run = [];
    for (const entry of held) items.push({ kind: "single", entry });
    held = [];
  };
  entries.forEach((entry, index) => {
    if (isTaskCall(entry) && !isTaskShown(entry, spawned)) return;
    if (entry.kind === "thinking" || isActivityCall(entry)) {
      // Texts before the first activity of a block open it as steps too.
      run.push(...held, entry);
      held = [];
      runEnd = ends[index];
      return;
    }
    if (entry.kind === "text") {
      held.push(entry);
      return;
    }
    settle();
    items.push({ kind: "single", entry });
  });
  settle();
  // Only the latest block of an open turn is still running: an earlier one
  // was left behind by a card, whatever the turn does next.
  let latest = -1;
  items.forEach((item, index) => {
    if (item.kind === "work") latest = index;
  });
  return items.map((item, index) => (item.kind === "work" && item.running && index !== latest ? { ...item, running: false } : item));
}

export type VerbKey = keyof ActivityDict["verbs"];

export function verbKey(call: ToolCallEntry): VerbKey {
  const subject = call.subject;
  if (subject?.kind === "search") return subject.mode === "files" ? "searchFiles" : "searchContent";
  if (subject?.kind === "web") return subject.mode === "search" ? "webSearch" : "webFetch";
  if (subject) return subject.kind;
  if (call.toolKind === "search") return "searchContent";
  if (call.toolKind === "web") return "webSearch";
  return call.toolKind;
}

const TARGET_MAX = 48;

function truncate(text: string): string {
  return text.length > TARGET_MAX ? `${text.slice(0, TARGET_MAX - 1)}…` : text;
}

export function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter((part) => part !== "");
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What a call is about, short enough for a sentence: the file's name, the
 * command's first line, the pattern, the query, the server and tool. */
export function callTarget(call: ToolCallEntry): string {
  const subject = call.subject;
  if (!subject) return truncate(call.name);
  switch (subject.kind) {
    case "read":
    case "edit":
    case "write":
      return basename(subject.path);
    case "shell":
      return truncate(subject.command.split("\n")[0]);
    case "search":
      return truncate(subject.pattern);
    case "web":
      return truncate(subject.mode === "search" ? subject.query : hostOf(subject.url));
    case "mcp":
      return `${subject.server}.${subject.tool}`;
    case "task":
    case "other":
      return truncate(subject.label);
  }
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}

/** One call's own duration, when both of its timestamps are known. */
export function callDuration(call: ToolCallEntry): number | undefined {
  return call.startedAt !== undefined && call.endedAt !== undefined ? Math.max(0, call.endedAt - call.startedAt) : undefined;
}

/** What a call acted on, as a chip: the file, command, search term, host or
 * app, with `+a −r` for a change. A call that names nothing falls back to the
 * tool's own name. */
export function callTargetChip(call: ToolCallEntry): WorkTarget {
  const subject = call.subject;
  const diff = call.outcome?.kind === "diff" ? { added: call.outcome.added, removed: call.outcome.removed } : undefined;
  const chip = (kind: WorkTargetKind, full: string, label: string): WorkTarget => ({ callId: call.id, kind, label, full, ...(diff ? { diff } : {}) });
  if (!subject) return chip("other", call.name, call.name);
  switch (subject.kind) {
    case "read":
    case "edit":
    case "write":
      return chip("file", subject.path, basename(subject.path));
    case "shell":
      return chip("command", subject.command, subject.command.split("\n")[0]);
    case "search":
      return chip("query", subject.pattern, subject.pattern);
    case "web":
      return subject.mode === "search" ? chip("query", subject.query, subject.query) : chip("domain", subject.url, hostOf(subject.url));
    case "mcp":
      return chip("app", `${subject.server}.${subject.tool}`, `${subject.server}.${subject.tool}`);
    case "task":
    case "other":
      return chip("other", subject.kind === "other" ? subject.label : call.name, subject.kind === "other" ? subject.label : call.name);
  }
}

/** The first line of a failed call's own message, for the step that failed —
 * the rest is one click away on the call. Empty when it said nothing. */
export function failureLine(call: ToolCallEntry): string {
  if (!call.isError || call.aborted) return "";
  const text = call.content ?? (call.outcome?.kind === "terminal" ? call.outcome.output : "");
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}

export type MetaPart = { kind: "text"; text: string } | { kind: "diff"; added: number; removed: number } | { kind: "error"; text: string };

function plural(pair: { one: string; many: string }, count: number): string {
  return count === 1 ? pair.one : fill(pair.many, { count });
}

/** The small right-hand detail of a row, only what the result itself says:
 * how many lines/files/matches/results, `+a −r` for a change, `exit N` for a
 * failed command. A field the runtime didn't report simply isn't shown. */
export function callMeta(call: ToolCallEntry, dict: ActivityDict): MetaPart | undefined {
  const outcome = call.outcome;
  if (!outcome) return undefined;
  switch (outcome.kind) {
    case "code":
      return { kind: "text", text: plural(dict.meta.lines, outcome.lines.length) };
    case "files":
      return { kind: "text", text: plural(dict.meta.files, outcome.total ?? outcome.paths.length) };
    case "matches":
      return { kind: "text", text: plural(dict.meta.matches, outcome.total ?? outcome.matches.length) };
    case "links":
      return { kind: "text", text: plural(dict.meta.results, outcome.results.length) };
    case "diff":
      return { kind: "diff", added: outcome.added, removed: outcome.removed };
    case "terminal":
      return call.isError && outcome.exitCode !== undefined ? { kind: "error", text: fill(dict.meta.exit, { code: outcome.exitCode }) } : undefined;
    case "payload":
    case "text":
      return undefined;
  }
}
