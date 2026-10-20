// The numbers the room's panels print, derived from what the relay reports.
// Pure: the words around them come from the dictionary at the call site.
import type { RoomAgent, RoomAgentUsage, RoomMemberInfo, RoomWorktree } from "@/lib/relay/roomClient";
import { cardStatus } from "@/lib/sala/agentCard";

/** `1.4 GB`, `312 MB`, `18 KB`, `0 B`: base 1024, one decimal under ten. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1)} ${units[unit]}`;
}

/** `12.4k`, `1.2M`: for token counts. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Every token an agent has been billed context for: what it sent fresh, what
 * it wrote to the cache and what it read back. */
export function totalTokens(usage: Pick<RoomAgentUsage, "inputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens">): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

export interface UsageRow {
  agentId: string;
  title: string | null;
  tokens: number;
  /** Whole percent of the room's total (0 when the room has none yet). */
  share: number;
  hitRate: number | null;
}

/** One row per agent that has used anything, biggest first. The relay knows
 * nothing about the person's plan, so the share is of the room, not of the
 * five-hour window. */
export function usageRows(members: readonly RoomMemberInfo[]): { rows: UsageRow[]; total: number } {
  const rows = members.map((m) => ({ agentId: m.id, title: m.title, tokens: totalTokens(m.usage), hitRate: m.usage.cacheHitRate }));
  const total = rows.reduce((sum, r) => sum + r.tokens, 0);
  return {
    total,
    rows: rows
      .filter((r) => r.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .map((r) => ({ ...r, share: total === 0 ? 0 : Math.round((r.tokens / total) * 100) })),
  };
}

export interface RoomCounts {
  agents: number;
  running: number;
  waiting: number;
  done: number;
  failed: number;
}

export function roomCounts(agents: readonly RoomAgent[]): RoomCounts {
  const liveWorkers = agents.filter((a) => a.role === "worker" && (a.state === "working" || a.state === "queued")).length;
  const counts: RoomCounts = { agents: agents.length, running: 0, waiting: 0, done: 0, failed: 0 };
  for (const agent of agents) {
    const { tone } = cardStatus(agent, agent.role === "principal" ? liveWorkers : 0);
    if (tone === "run" || tone === "start") counts.running += 1;
    else if (tone === "wait") counts.waiting += 1;
    else if (tone === "done") counts.done += 1;
    else if (tone === "fail") counts.failed += 1;
  }
  return counts;
}

/** The worktrees an agent made, with what the summary line says of them. */
export interface AgentWork {
  branch: string;
  commits: number | undefined;
  integrated: boolean;
  sizeBytes: number | undefined;
  /** Why the relay keeps it after the agent is done, when it does. */
  retainedReason: string | undefined;
}

export function agentWork(worktrees: readonly RoomWorktree[], agentId: string): AgentWork[] {
  return worktrees
    .filter((w) => w.agentId === agentId)
    .map((w) => ({ branch: w.branch, commits: w.commitsAhead, integrated: w.integrated, sizeBytes: w.sizeBytes, retainedReason: w.retainedReason }));
}

/** Worktrees that are still on disk with work in them nobody integrated. */
export function retainedWorktrees(worktrees: readonly RoomWorktree[]): RoomWorktree[] {
  return worktrees.filter((w) => !w.integrated || w.retainedReason !== undefined);
}

/** How long ago, in whole units: `now`, `3 min`, `2 h`, `5 d` (the words are
 * the caller's). */
export function ageUnits(ms: number): { unit: "now" | "min" | "hour" | "day"; value: number } {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return { unit: "now", value: 0 };
  if (minutes < 60) return { unit: "min", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { unit: "hour", value: hours };
  return { unit: "day", value: Math.floor(hours / 24) };
}
