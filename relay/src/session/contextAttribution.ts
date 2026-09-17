import type { AgentEvent } from "../protocol/agent-event.js";

/** One delta's worth of tool/user-message cost — `toolUseIds` empty means
 * the delta came from a plain user message with no tool call in between
 * (there's no dedicated "source" field: a consumer distinguishes the two by
 * whether this array is empty). `estimated` is always `false` here — this
 * is the whole delta's own exact total, never a per-source split (that's a
 * later problem: dividing this total across more than one `toolUseIds`
 * entry when several tool calls ran in parallel). */
export interface Attribution {
  readonly tokens: number;
  readonly toolUseIds: readonly string[];
  readonly estimated: boolean;
}

export interface AttributionStep {
  /** Set exactly once per `ContextAttributor` instance — the first `usage`
   * of a conversation that didn't already have one (see
   * `ContextAttributorOptions.hasPriorConversation`). Never re-set after a
   * `compact_boundary`: compaction restarts the predecessor, not the
   * conversation. */
  readonly baseline?: number;
  /** `prefixTokens` of this response — the live "used" number, regardless
   * of whether a predecessor was known to attribute the delta to anything. */
  readonly used: number;
  readonly contextWindowSize?: number;
  /** Absent whenever the predecessor is unknown: the conversation's very
   * first response (see `baseline` instead), the first response after a
   * relay restart resumed a session mid-conversation, or the first response
   * after a `compact_boundary`. */
  readonly attribution?: Attribution;
}

export interface ContextAttributorOptions {
  /** `false` for a conversation's first-ever turn (the only case
   * `baseline` can fire for) — `true` for a session resumed after a relay
   * restart, where the predecessor is unknown but this isn't the start of
   * the conversation either. */
  readonly hasPriorConversation: boolean;
}

/**
 * Correlates each response's `usage` event with whatever ran since the
 * previous one — the delta-of-prefix finding: `prefix(N) - prefix(N-1) -
 * output(N-1)` is exactly what a tool_result or user message injected in
 * between, to the token (verified against real sessions: a single `Read`
 * measured at 13,472 tokens this way).
 *
 * NEVER use `cacheCreationInputTokens` as a shortcut for the delta, even
 * though it usually matches it — measured divergence in a real session: a
 * `cache_creation_input_tokens` of 82,752 for a prefix that only grew by
 * 7,150, because a cache block expired and the whole prefix got rewritten
 * into a fresh cache entry. `prefixTokens` (already normalized per agent,
 * see `agent-event.ts`) is the only reliable delta source, which is why
 * this class never reads the raw Claude-specific fields off the event.
 *
 * Known imprecision: Claude's `outputTokens` on the live `usage` event is
 * measured unreliable (see `claudeStreamJson.ts`'s own comment) — it stays
 * near a small constant regardless of the real reply length. Subtracting
 * too little for `predecessor.outputTokens` means `attribution.tokens`
 * here is a slight OVER-estimate for Claude whenever the previous response
 * had substantial output text. Codex's `outputTokens` (a structured daemon
 * notification, not scraped from a text stream) doesn't have this problem.
 */
export class ContextAttributor {
  private predecessor: { readonly prefixTokens: number; readonly outputTokens: number } | undefined;
  private awaitingBaseline: boolean;
  private pendingToolUseIds: string[] = [];

  constructor(opts: ContextAttributorOptions) {
    this.awaitingBaseline = !opts.hasPriorConversation;
  }

  observe(event: AgentEvent): AttributionStep | undefined {
    if (event.type === "compact_boundary") {
      // The series must never cross a compaction: the prefix drops back
      // down (measured: a delta of -589,482 in a real session), which
      // isn't a real "source" to attribute anything to. The predecessor
      // becomes unknown again — same shape as a resumed session's first
      // response — but `awaitingBaseline` is NOT reset: `baseline` means
      // "conversation start," and a compaction is a mid-conversation event.
      this.predecessor = undefined;
      this.pendingToolUseIds = [];
      return undefined;
    }
    if (event.type === "tool_ended") {
      if (event.toolUseId) this.pendingToolUseIds.push(event.toolUseId);
      return undefined;
    }
    if (event.type !== "usage") return undefined;

    const { prefixTokens: used, outputTokens, contextWindowSize } = event;
    const toolUseIds = this.pendingToolUseIds;
    this.pendingToolUseIds = [];

    if (!this.predecessor) {
      const baseline = this.awaitingBaseline ? used : undefined;
      this.awaitingBaseline = false;
      this.predecessor = { prefixTokens: used, outputTokens };
      return {
        ...(baseline !== undefined ? { baseline } : {}),
        used,
        ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
      };
    }

    const delta = used - this.predecessor.prefixTokens;
    const attributedTokens = delta - this.predecessor.outputTokens;
    this.predecessor = { prefixTokens: used, outputTokens };

    return {
      used,
      ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
      attribution: { tokens: attributedTokens, toolUseIds, estimated: false },
    };
  }
}
