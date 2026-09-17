import type { AgentEvent } from "../protocol/agent-event.js";

/** This delta's own share of `Attribution.tokens`, for one tool call. */
export interface AttributedSource {
  readonly toolUseId: string;
  readonly tokens: number;
}

/** One delta's worth of tool/user-message cost — `toolUseIds` empty means
 * the delta came from a plain user message with no tool call in between
 * (there's no dedicated "source" field: a consumer distinguishes the two by
 * whether this array is empty).
 *
 * `bySource` always sums to exactly `tokens`, one entry per `toolUseIds`
 * entry, same order. A single-source batch's one entry equals `tokens`
 * itself (`estimated: false` — the number is exact). A parallel batch (more
 * than one `tool_ended` since the last `usage`) divides `tokens`
 * proportionally by each tool's own `tool_ended.content.length`
 * (`estimated: true`) — the DIVISION is a model (two parallel calls of very
 * different real cost could report the same content length), even though
 * the total it divides remains exact. */
export interface Attribution {
  readonly tokens: number;
  readonly toolUseIds: readonly string[];
  readonly estimated: boolean;
  readonly bySource: readonly AttributedSource[];
}

/**
 * Splits `total` across `weights` proportionally, guaranteeing the shares
 * sum to exactly `total` (never `total ± rounding`) — every share but the
 * last is rounded down or to nearest and the last absorbs whatever's left,
 * the same trick apportionment methods use to keep a fixed total exact
 * across rounded parts. Equal split when every weight is 0 (e.g. two
 * `tool_ended`s that both reported empty content) rather than dividing by
 * a zero `totalWeight`.
 */
function divideProportionally(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  if (weights.length === 1) return [total];
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const shares: number[] = [];
  let allocated = 0;
  for (let i = 0; i < weights.length - 1; i++) {
    const share = totalWeight > 0 ? Math.round((total * weights[i]) / totalWeight) : Math.round(total / weights.length);
    shares.push(share);
    allocated += share;
  }
  shares.push(total - allocated);
  return shares;
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
  /** One entry per `tool_ended` observed since the last `usage` step —
   * `contentLength` is that tool's own `content.length`, the weight
   * `divideProportionally` splits the next delta by. Verified against 8
   * real transcripts (49 parallel batches, all size 2 or 3): `usage` never
   * arrives mid-batch, so this never needs to flush a partial batch. */
  private pendingBatch: { readonly toolUseId: string; readonly contentLength: number }[] = [];

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
      this.pendingBatch = [];
      return undefined;
    }
    if (event.type === "tool_ended") {
      if (event.toolUseId) this.pendingBatch.push({ toolUseId: event.toolUseId, contentLength: event.content.length });
      return undefined;
    }
    if (event.type !== "usage") return undefined;

    const { prefixTokens: used, outputTokens, contextWindowSize } = event;
    const batch = this.pendingBatch;
    this.pendingBatch = [];

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

    const shares = divideProportionally(attributedTokens, batch.map((entry) => entry.contentLength));
    const bySource: AttributedSource[] = batch.map((entry, index) => ({ toolUseId: entry.toolUseId, tokens: shares[index] }));

    return {
      used,
      ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
      attribution: {
        tokens: attributedTokens,
        toolUseIds: batch.map((entry) => entry.toolUseId),
        estimated: batch.length > 1,
        bySource,
      },
    };
  }
}
