import type { Dictionary } from "@/i18n";
import type { LogEntry, ToolCallEntry } from "@/hooks/relay/useMessageLog";

type ActivityDict = Dictionary["chat"]["activity"];

/** A row of the message log after grouping: either one entry as it is, or a
 * run of consecutive tool calls drawn as one summarized line. */
export type TimelineItem = { kind: "single"; entry: LogEntry } | { kind: "group"; id: string; calls: ToolCallEntry[] };

/** Whether a call is part of the flowing activity, as opposed to the two
 * kinds that keep a card of their own: a delegated task (its work happens
 * out of sight, the card is the only window into it) and a plan (a
 * checklist, not an action). */
export function isActivityCall(entry: LogEntry): entry is ToolCallEntry {
  return entry.kind === "tool-call" && entry.plan === undefined && entry.toolKind !== "task";
}

/**
 * Groups the log for display. A group is the longest run of activity calls
 * with nothing between them — text, reasoning, an error or a note each end
 * it. A call that failed stays in its group (the group says how many did).
 * Adjacency in the log, not turn boundaries, is the rule: it reads the same
 * live and on replay, without a concept the wire doesn't carry.
 */
export function buildTimeline(entries: LogEntry[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let run: ToolCallEntry[] = [];
  const flush = (): void => {
    if (run.length > 0) items.push({ kind: "group", id: run[0].id, calls: run });
    run = [];
  };
  for (const entry of entries) {
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
type CountKey = keyof ActivityDict["counts"];

export function verbKey(call: ToolCallEntry): VerbKey {
  const subject = call.subject;
  if (subject?.kind === "search") return subject.mode === "files" ? "searchFiles" : "searchContent";
  if (subject?.kind === "web") return subject.mode === "search" ? "webSearch" : "webFetch";
  if (subject) return subject.kind;
  if (call.toolKind === "search") return "searchContent";
  if (call.toolKind === "web") return "webSearch";
  return call.toolKind;
}

function countKey(call: ToolCallEntry): CountKey {
  const kind = call.subject?.kind ?? call.toolKind;
  return kind;
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

function phraseFor(call: ToolCallEntry, dict: ActivityDict): string {
  const verb = dict.verbs[verbKey(call)];
  const target = callTarget(call);
  return call.done ? fill(verb.past, { target }) : `${fill(verb.ing, { target })}…`;
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Consecutive identical phrases collapse: "ran the tests, ran the tests"
 * reads as "ran the tests 2×". */
function collapseRepeats(phrases: string[]): string[] {
  const out: { phrase: string; count: number }[] = [];
  for (const phrase of phrases) {
    const last = out[out.length - 1];
    if (last && last.phrase === phrase) last.count += 1;
    else out.push({ phrase, count: 1 });
  }
  return out.map(({ phrase, count }) => (count > 1 ? `${phrase} ${count}×` : phrase));
}

/** A group longer than this is described by counts, not call by call. */
export const GROUP_DETAIL_LIMIT = 4;

export interface GroupSummary {
  /** The sentence: one phrase per call up to the limit, counts by kind
   * beyond it, and anything still running listed in the gerund. */
  text: string;
  /** Calls that belong to a batch of two or more issued together. */
  parallel: number;
  failed: number;
  running: boolean;
}

export function summarizeGroup(calls: ToolCallEntry[], dict: ActivityDict): GroupSummary {
  const running = calls.some((call) => !call.done);
  let phrases: string[];

  if (calls.length <= GROUP_DETAIL_LIMIT) {
    phrases = collapseRepeats(calls.map((call) => phraseFor(call, dict)));
  } else {
    const order: CountKey[] = [];
    const counts = new Map<CountKey, number>();
    for (const call of calls) {
      if (!call.done) continue;
      const key = countKey(call);
      if (!counts.has(key)) order.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    phrases = order.map((key) => {
      const n = counts.get(key) ?? 0;
      return n === 1 ? dict.counts[key].one : fill(dict.counts[key].many, { count: n });
    });
    phrases.push(...collapseRepeats(calls.filter((call) => !call.done).map((call) => phraseFor(call, dict))));
  }

  const text = phrases.map((phrase, index) => (index === 0 ? upperFirst(phrase) : lowerFirst(phrase))).join(", ");

  const batchSizes = new Map<string, number>();
  for (const call of calls) if (call.batchId) batchSizes.set(call.batchId, (batchSizes.get(call.batchId) ?? 0) + 1);
  const parallel = calls.filter((call) => call.batchId !== undefined && (batchSizes.get(call.batchId) ?? 0) > 1).length;

  const failed = calls.filter((call) => call.isError && !call.aborted).length;
  return { text, parallel, failed, running };
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
