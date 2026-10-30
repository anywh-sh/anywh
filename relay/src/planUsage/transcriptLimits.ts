// "Limited until X" for Claude without a probe: when Claude Code hits the
// account's limit it writes the refusal into the session transcript, with
// the limit attached (Claude Code 2.1.303, `~/.claude/projects/**/*.jsonl`):
//
//   {"type":"assistant","timestamp":"2026-10-30T03:31:47.112Z",
//    "apiError":"usage_limit_reached",
//    "apiErrorParams":{"rate_limit_info":{"status":"rejected",
//      "resetsAt":1793333400,"rateLimitType":"five_hour",...}}, ...}
//
// That is the only usage data transcripts carry: an ordinary turn's
// `rate_limit_event` is not written there. So this can only say "limited
// until X", and only while X is in the future.
//
// Cost and privacy: only the most recently modified transcripts, only their
// tail, and only `apiErrorParams.rate_limit_info` of a matching line is read
// — never logged, never kept. A transcript holds the conversation itself.
import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectsDir } from "./transcriptActivity.js";
import { PLAN_WINDOW_MINS, type PlanWindow } from "./types.js";
import { epochSecondsToMs, isRecord } from "./windows.js";

export interface TranscriptLimit {
  /** The window the refusal named, at 100 %. */
  window: PlanWindow;
  /** When Claude Code wrote the refusal, epoch ms. */
  observedAt: number;
}

export interface ReadTranscriptLimitOptions {
  env?: NodeJS.ProcessEnv;
  /** How many of the most recently modified transcripts to look at. */
  maxFiles?: number;
  /** How much of the end of each to read. */
  tailBytes?: number;
}

const DEFAULT_MAX_FILES = 5;
const DEFAULT_TAIL_BYTES = 64 * 1024;
// projects/<project>/<session>/subagents/*.jsonl is four levels down.
const MAX_DEPTH = 4;
// A weekly limit is the longest a refusal can stay true.
const MAX_AGE_MS = PLAN_WINDOW_MINS.sevenDay * 60_000;

function durationOf(rateLimitType: unknown): { durationMins: number; limitId?: string } | null {
  if (rateLimitType === "five_hour") return { durationMins: PLAN_WINDOW_MINS.fiveHour };
  if (rateLimitType === "seven_day") return { durationMins: PLAN_WINDOW_MINS.sevenDay };
  if (typeof rateLimitType === "string" && rateLimitType.startsWith("seven_day_")) return { durationMins: PLAN_WINDOW_MINS.sevenDay, limitId: rateLimitType };
  return null;
}

/** One transcript line → the limit it records, if it is a refusal with a
 * `rate_limit_info` naming a known window. Pure. */
export function parseTranscriptLimitLine(line: string): TranscriptLimit | null {
  // Cheap filter first: almost no line is a refusal.
  if (!line.includes('"apiErrorParams"')) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(entry) || !isRecord(entry.apiErrorParams)) return null;
  const info = entry.apiErrorParams.rate_limit_info;
  if (!isRecord(info) || info.status !== "rejected") return null;
  const duration = durationOf(info.rateLimitType);
  const resetsAt = epochSecondsToMs(info.resetsAt);
  const observedAt = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  if (!duration || resetsAt === null || !Number.isFinite(observedAt)) return null;
  return { window: { ...duration, usedPercent: 100, resetsAt }, observedAt };
}

async function list(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function collect(dir: string, depth: number, since: number, out: { path: string; mtimeMs: number }[]): Promise<void> {
  for (const entry of await list(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await collect(path, depth + 1, since, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const { mtimeMs } = await stat(path);
        if (mtimeMs >= since) out.push({ path, mtimeMs });
      } catch {
        // Deleted between the listing and the stat.
      }
    }
  }
}

async function readTail(path: string, bytes: number): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    // The first line of a tail that doesn't start at 0 is cut.
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

/**
 * The latest refusal recorded in the profile's most recent transcripts,
 * when the window it names is still running at `now`. Undefined otherwise.
 * Never rejects.
 */
export async function readClaudeTranscriptLimit(home: string, now: number, options: ReadTranscriptLimitOptions = {}): Promise<TranscriptLimit | undefined> {
  const files: { path: string; mtimeMs: number }[] = [];
  await collect(claudeProjectsDir(home, options.env), 1, now - MAX_AGE_MS, files);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let latest: TranscriptLimit | undefined;
  for (const { path } of files.slice(0, options.maxFiles ?? DEFAULT_MAX_FILES)) {
    let lines: string[];
    try {
      lines = await readTail(path, options.tailBytes ?? DEFAULT_TAIL_BYTES);
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const limit = parseTranscriptLimitLine(lines[i] ?? "");
      if (!limit) continue;
      if (!latest || limit.observedAt > latest.observedAt) latest = limit;
      break;
    }
  }
  if (!latest || latest.window.resetsAt === null || latest.window.resetsAt <= now) return undefined;
  return latest;
}
