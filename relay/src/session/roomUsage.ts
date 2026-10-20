// What each agent of a room has read from the model's cache and what it had
// to write, response by response. The hit rate is the signal that agents
// born together are sharing a prompt (a sibling with a low one was launched
// cold or with a prefix that differs). Output tokens are left out on
// purpose: the live stream's count for them is not reliable.
//
// Pure: no I/O.
import type { AgentEvent } from "../protocol/agent-event.js";

const SEEN_LIMIT = 512;

export interface AgentUsage {
  responses: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** `cache_read / (cache_read + cache_creation + input)`, over everything
   * counted so far; `null` before any response. */
  cacheHitRate: number | null;
}

export class UsageTally {
  private readonly totals = new Map<string, Omit<AgentUsage, "cacheHitRate">>();
  // Response ids already counted, per agent, newest last. Bounded: a replay
  // only ever repeats recent responses.
  private readonly seen = new Map<string, Set<string>>();

  /** Counts a `usage` event of `agentId`; any other event is ignored. */
  observe(agentId: string, event: AgentEvent): void {
    if (event.type !== "usage") return;
    // Claude emits one event per content block of a response, all with the
    // same id and usage — and a replayed log repeats them. Count each once.
    if (event.messageId !== undefined) {
      const ids = this.seen.get(agentId) ?? new Set<string>();
      if (ids.has(event.messageId)) return;
      ids.add(event.messageId);
      if (ids.size > SEEN_LIMIT) ids.delete(ids.values().next().value as string);
      this.seen.set(agentId, ids);
    }
    const total = this.totals.get(agentId) ?? { responses: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    total.responses += 1;
    total.inputTokens += event.inputTokens;
    total.cacheCreationInputTokens += event.cacheCreationInputTokens;
    total.cacheReadInputTokens += event.cacheReadInputTokens;
    this.totals.set(agentId, total);
  }

  get(agentId: string): AgentUsage {
    const total = this.totals.get(agentId) ?? { responses: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const all = total.inputTokens + total.cacheCreationInputTokens + total.cacheReadInputTokens;
    return { ...total, cacheHitRate: all === 0 ? null : total.cacheReadInputTokens / all };
  }

  forget(agentId: string): void {
    this.totals.delete(agentId);
    this.seen.delete(agentId);
  }
}
