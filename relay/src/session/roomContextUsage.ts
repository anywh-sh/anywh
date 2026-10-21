// How full each agent's context window is right now, as far as the live
// stream says: the prefix of its latest main-thread response (what an
// ordinary session's context button shows too) and, when the stream carries
// it, the window. Nothing accumulates: a response replaces the one before.
//
// Pure: no I/O.
import type { AgentEvent } from "../protocol/agent-event.js";

export interface AgentContext {
  /** Tokens of the latest response's prefix (input + cache write + cache read). */
  usedTokens: number;
  /** Known from the stream only for some runtimes (Codex); Claude's comes
   * from the turn's result, via the session store. */
  contextWindowSize?: number;
}

export class ContextTally {
  private readonly latest = new Map<string, AgentContext>();

  /** Records a `usage` event of `agentId`; any other event is ignored. */
  observe(agentId: string, event: AgentEvent): void {
    if (event.type !== "usage") return;
    const previous = this.latest.get(agentId);
    const contextWindowSize = event.contextWindowSize ?? previous?.contextWindowSize;
    this.latest.set(agentId, { usedTokens: event.prefixTokens, ...(contextWindowSize !== undefined ? { contextWindowSize } : {}) });
  }

  get(agentId: string): AgentContext | undefined {
    return this.latest.get(agentId);
  }

  forget(agentId: string): void {
    this.latest.delete(agentId);
  }
}
