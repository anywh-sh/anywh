import type { BroadcastMessage } from "./sharedSession.js";

/** How many complete turns to send right away to a client that just
 * connected — an educated
 * guess until calibrated against a real large case (e.g. "IVT Fix", ~1670
 * reconstructed transcript lines). The rest comes on demand via
 * `load_older_history` when the user scrolls up. */
export const INITIAL_HISTORY_TAIL_TURNS = 20;

export interface HistoryPage {
  messages: BroadcastMessage[];
  /** Index (within `history`) of the first event on this page — this is
   * what the client sends back as `beforeCursor` to request the previous
   * (older) page. */
  cursor: number;
  /** If `false`, `cursor` is `0` and there's no turn older than this page
   * to fetch. */
  hasMore: boolean;
}

function isTurnBoundary(message: BroadcastMessage): boolean {
  return message.type === "turn_complete" || message.type === "turn_error";
}

/** Start indices of each turn within `history`. A turn goes from its start
 * index up to (inclusive) the next `turn_complete`/`turn_error` — except
 * the last one, which stays "open" (no terminator yet) if there genuinely
 * is a turn in progress at the moment this runs. Doesn't require a
 * `user_prompt` marking the start (live history before Phase 1 didn't have
 * that) — the cut uses only the end terminator, present in both cases. */
function turnStartIndices(history: BroadcastMessage[]): number[] {
  if (history.length === 0) return [];
  const starts = [0];
  for (let i = 0; i < history.length; i++) {
    if (isTurnBoundary(history[i]) && i + 1 < history.length) starts.push(i + 1);
  }
  return starts;
}

/**
 * Returns up to `maxTurns` complete turns immediately before `beforeCursor`
 * (exclusive). `beforeCursor: history.length` fetches the most recent tail
 * (used by `SharedSession.addClient`); the `cursor` returned by one page
 * fetches the next, older page (used by `SharedSession.loadOlderHistory`) —
 * both cases are the same function.
 */
export function pageHistoryBefore(history: BroadcastMessage[], beforeCursor: number, maxTurns: number): HistoryPage {
  const starts = turnStartIndices(history).filter((start) => start < beforeCursor);
  if (starts.length === 0) return { messages: [], cursor: 0, hasMore: false };
  const cutoffIndex = Math.max(0, starts.length - maxTurns);
  const cursor = starts[cutoffIndex];
  return { messages: history.slice(cursor, beforeCursor), cursor, hasMore: cutoffIndex > 0 };
}

/** `true` only for the automatic follow-up turn of a finished `anywh-bg`
 * job — never appears to the user as an editable message
 * (the client renders it as a system note, `kind: "background-job-note"`,
 * not as a `kind: "user"` bubble). Old messages from before turns carried a
 * `user_prompt` marking their start fall through to the
 * `false` default — treated as real, same behavior that already existed
 * before this distinction existed. */
function isSyntheticBackgroundJobStart(message: BroadcastMessage): boolean {
  return (
    message.type === "claude_event" && message.event.type === "user_prompt" && message.event.synthetic === "background_job"
  );
}

export interface EditTarget {
  /** Index in `history` where the edited turn starts — everything from here
   * (inclusive) is discarded. */
  cutIndex: number;
  /** How many turns (real + synthetic) precede this point. Each turn, real
   * or synthetic, corresponds to exactly one `claude -p` call and therefore
   * exactly one `user` line in the real `.jsonl` — that's why this number
   * is also the parameter `transcriptFork.ts` needs to cut the file at the
   * same spot, without needing to reconstruct the real/synthetic
   * distinction from disk. */
  turnsBefore: number;
}

/**
 * Finds the cut point to edit the `fromEnd`-th user message counting from
 * the end (`1` = the last one) — skips synthetic `anywh-bg` turns while
 * counting, since they don't appear to the user as an editable message.
 * `undefined` if `fromEnd` is greater than the number of real
 * turns that exist (invalid/stale request — the caller should refuse
 * instead of truncating incorrectly).
 */
export function findEditTarget(history: BroadcastMessage[], fromEnd: number): EditTarget | undefined {
  const starts = turnStartIndices(history);
  let realTurnsSeen = 0;
  for (let k = starts.length - 1; k >= 0; k--) {
    if (isSyntheticBackgroundJobStart(history[starts[k]])) continue;
    realTurnsSeen++;
    if (realTurnsSeen === fromEnd) return { cutIndex: starts[k], turnsBefore: k };
  }
  return undefined;
}
