import type { AgentEvent } from "../protocol/agent-event.js";

/**
 * Gives every live event of a turn the timing a UI needs to show "running
 * for 3.2s", "thought for 4s" and "worked 12s" — with the relay as the one
 * clock every def shares.
 *
 * A def fills in real timestamps when its CLI reports them (Codex stamps
 * each item's start and end); Claude's stream reports none on tool calls, so
 * without this the same UI would work for one agent and not the other.
 * Anything a def already set is kept as is: this only fills gaps, stamping
 * the moment the event reached the relay, which for a streamed event is as
 * close to the real time as the relay can know.
 *
 * One instance per turn. Stateful only for reasoning: a `thinking` block's
 * start is the `thinking_started` that preceded it (blocks never overlap, so
 * the most recent open one is always the right one), falling back to its own
 * arrival when the def never announced a start.
 */
export class ActivityClock {
  private readonly turnStartedAt: number;
  private openThinkingStartedAt: number | undefined;

  constructor(private readonly now: () => number) {
    this.turnStartedAt = now();
  }

  /** The turn's own start, fixed at construction — the same value the
   * `turn_started` event and the `turn_state` "current state" message
   * carry, so the two never disagree. */
  get startedAt(): number {
    return this.turnStartedAt;
  }

  turnStarted(): AgentEvent {
    return { type: "turn_started", startedAt: this.turnStartedAt };
  }

  turnEnded(stopped: boolean): AgentEvent {
    return { type: "turn_ended", stopped, durationMs: Math.max(0, this.now() - this.turnStartedAt) };
  }

  stamp(event: AgentEvent): AgentEvent {
    switch (event.type) {
      case "tool_started":
        return event.startedAt !== undefined ? event : { ...event, startedAt: this.now() };
      case "tool_ended":
        return event.endedAt !== undefined ? event : { ...event, endedAt: this.now() };
      case "thinking_started": {
        const startedAt = event.startedAt ?? this.now();
        this.openThinkingStartedAt = startedAt;
        return event.startedAt !== undefined ? event : { ...event, startedAt };
      }
      case "thinking": {
        const endedAt = event.endedAt ?? this.now();
        const startedAt = event.startedAt ?? this.openThinkingStartedAt ?? endedAt;
        this.openThinkingStartedAt = undefined;
        return { ...event, startedAt, endedAt };
      }
      // Listed rather than a `default:` so a new variant that should carry
      // timing is a lint error here instead of silently passing unstamped.
      // `turn_started`/`turn_ended` never come through here: the session
      // synthesizes them from this same clock (`turnStarted`/`turnEnded`).
      case "turn_started":
      case "turn_ended":
      case "user_message":
      case "text_delta":
      case "text":
      case "thinking_delta":
      case "tool_input_delta":
      case "tool_progress":
      case "plan":
      case "subagent":
      case "session_id":
      case "usage":
      case "status":
      case "compact_boundary":
      case "context_attribution":
      case "error":
        return event;
    }
  }
}
