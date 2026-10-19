import type { Dictionary } from "@/i18n";
import type { LogEntry, ToolCallEntry } from "@/hooks/relay/useMessageLog";

type ActivityDict = Dictionary["chat"]["activity"];

/** A row of the message log after grouping: either one entry as it is, or a
 * run of consecutive tool calls drawn as one summarized line. */
export type TimelineItem = { kind: "single"; entry: LogEntry } | { kind: "group"; id: string; calls: ToolCallEntry[] };

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

/**
 * Groups the log for display. A group is the longest run of activity calls
 * with nothing between them — text, reasoning, an error or a note each end
 * it. A call that failed stays in its group (the group says how many did).
 * Adjacency in the log, not turn boundaries, is the rule: it reads the same
 * live and on replay, without a concept the wire doesn't carry.
 *
 * `spawned` is the `toolUseId`s the CLI reported a subagent for. A task that
 * isn't shown (`isTaskShown`) is left out — it neither joins nor splits a
 * group; one that is shown ends the run like any card.
 */
export function buildTimeline(entries: LogEntry[], spawned: ReadonlySet<string> = new Set()): TimelineItem[] {
  const items: TimelineItem[] = [];
  let run: ToolCallEntry[] = [];
  const flush = (): void => {
    if (run.length > 0) items.push({ kind: "group", id: run[0].id, calls: run });
    run = [];
  };
  for (const entry of entries) {
    if (isTaskCall(entry) && !isTaskShown(entry, spawned)) continue;
    if (isActivityCall(entry)) {
      run.push(entry);
      continue;
    }
    flush();
    items.push({ kind: "single", entry });
  }
  flush();
  return items;
}

type VerbKey = keyof ActivityDict["verbs"];

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

export interface GroupStatus {
  /** Calls in the group — what the header counts. */
  count: number;
  running: boolean;
  /** Failed calls; one the user stopped is not a failure. */
  failed: number;
}

/** What a group's header says: how many calls, whether any still runs, how
 * many failed. The header is a count, not a sentence — each row names its own
 * call, so a group of forty never grows a forty-clause line. */
export function groupStatus(calls: ToolCallEntry[]): GroupStatus {
  return {
    count: calls.length,
    running: calls.some((call) => !call.done),
    failed: calls.filter((call) => call.isError && !call.aborted).length,
  };
}

/** The group's total time once every call ended with timestamps: first start
 * to last end, so parallel calls are not double counted. Undefined while
 * anything is open or when a call has no timestamps (an older replay) — the
 * header then simply omits it instead of guessing. */
export function groupDuration(calls: ToolCallEntry[]): number | undefined {
  if (calls.length === 0) return undefined;
  const starts: number[] = [];
  const ends: number[] = [];
  for (const call of calls) {
    if (!call.done || call.startedAt === undefined || call.endedAt === undefined) return undefined;
    starts.push(call.startedAt);
    ends.push(call.endedAt);
  }
  return Math.max(...ends) - Math.min(...starts);
}

/** One call's own duration, when both of its timestamps are known. */
export function callDuration(call: ToolCallEntry): number | undefined {
  return call.startedAt !== undefined && call.endedAt !== undefined ? Math.max(0, call.endedAt - call.startedAt) : undefined;
}

/** Whether the whole group is one parallel batch — the case where the
 * expanded list gets a batch header. */
export function groupBatch(calls: ToolCallEntry[]): { count: number; durationMs?: number } | undefined {
  if (calls.length < 2) return undefined;
  const batchId = calls[0].batchId;
  if (batchId === undefined || !calls.every((call) => call.batchId === batchId)) return undefined;
  const starts = calls.map((call) => call.startedAt).filter((t): t is number => t !== undefined);
  const ends = calls.map((call) => call.endedAt).filter((t): t is number => t !== undefined);
  const complete = calls.every((call) => call.done && call.endedAt !== undefined);
  const durationMs = complete && starts.length > 0 && ends.length > 0 ? Math.max(...ends) - Math.min(...starts) : undefined;
  return { count: calls.length, ...(durationMs !== undefined ? { durationMs } : {}) };
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
