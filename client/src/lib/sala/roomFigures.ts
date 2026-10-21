// The numbers the room's panels print, derived from what the relay reports.
// Pure: the words around them come from the dictionary at the call site.
import type { RoomAgent, RoomAgentContext, RoomMemberInfo, RoomWorktree } from "@/lib/relay/roomClient";
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

/** Whole percent of the window an agent's context fills; `null` while the
 * window is not known (before the agent's first turn ends). */
export function windowPercent(context: RoomAgentContext): number | null {
  const window = context.contextWindowSize;
  if (window === undefined || window <= 0) return null;
  return Math.min(100, Math.round((context.usedTokens / window) * 100));
}

export interface UsageRow {
  agentId: string;
  title: string | null;
  /** Tokens in the agent's context right now. */
  tokens: number;
  percent: number | null;
}

/** One row per agent that has answered, the fullest context first (agents
 * whose window is not known yet last, by tokens). */
export function usageRows(members: readonly RoomMemberInfo[]): UsageRow[] {
  return members
    .flatMap((m) => (m.contextUsage && m.contextUsage.usedTokens > 0 ? [{ agentId: m.id, title: m.title, tokens: m.contextUsage.usedTokens, percent: windowPercent(m.contextUsage) }] : []))
    .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1) || b.tokens - a.tokens);
}

export interface RoomCounts {
  agents: number;
  running: number;
  waiting: number;
  done: number;
  failed: number;
}

/** The room's headline numbers. The principal only delegates and never
 * reports, so it is left out of the agent, running and done counts (it would
 * stay "idle" forever and the figures would never add up); what needs the
 * person, or failed, counts everyone, the principal included. */
export function roomCounts(agents: readonly RoomAgent[]): RoomCounts {
  const liveWorkers = agents.filter((a) => a.role === "worker" && (a.state === "working" || a.state === "queued")).length;
  const counts: RoomCounts = { agents: 0, running: 0, waiting: 0, done: 0, failed: 0 };
  for (const agent of agents) {
    const { tone } = cardStatus(agent, agent.role === "principal" ? liveWorkers : 0);
    const worker = agent.role !== "principal";
    if (worker) counts.agents += 1;
    if (tone === "wait") counts.waiting += 1;
    else if (tone === "fail") counts.failed += 1;
    else if (worker && (tone === "run" || tone === "start")) counts.running += 1;
    else if (worker && tone === "done") counts.done += 1;
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
