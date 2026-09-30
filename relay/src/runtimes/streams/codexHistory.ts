import type { AgentEvent } from "../../protocol/agent-event.js";
import { mapCodexNotification } from "./codexAppServer.js";

/**
 * Turns the turns a Codex thread stored (`thread/turns/list` with full items)
 * into the same `AgentEvent`s a live turn would have produced, so a reopened
 * session renders exactly like a running one. Pure: item-to-event mapping is
 * `mapCodexNotification`'s — each stored item is replayed as the
 * `item/started` + `item/completed` pair the daemon would have sent live.
 *
 * Stored items carry no per-item timestamps, only the turn's own, which is
 * all a replay needs: per-call timing is only ever shown while a call runs.
 */

interface StoredTurn {
  status?: string;
  /** Unix seconds. */
  startedAt?: number | null;
  durationMs?: number | null;
  items?: unknown[];
}

interface StoredUserInput {
  type?: string;
  text?: string;
}

function userText(item: { content?: unknown }): string {
  if (!Array.isArray(item.content)) return "";
  return (item.content as StoredUserInput[])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function codexTurnsToEvents(turns: StoredTurn[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const turn of turns) {
    const startedAtMs = typeof turn.startedAt === "number" ? turn.startedAt * 1000 : undefined;
    events.push({ type: "turn_started", ...(startedAtMs !== undefined ? { startedAt: startedAtMs } : {}) });

    for (const raw of turn.items ?? []) {
      const item = raw as { type?: string; content?: unknown };
      if (!item || typeof item !== "object") continue;
      if (item.type === "userMessage") {
        const text = userText(item);
        if (text) {
          events.push({ type: "user_message", text, ...(startedAtMs !== undefined ? { timestamp: new Date(startedAtMs).toISOString() } : {}) });
        }
        continue;
      }
      // A reasoning block is only announced live so it can show as running;
      // in a replay it is already over.
      if (item.type !== "reasoning") events.push(...mapCodexNotification("item/started", { item }));
      events.push(...mapCodexNotification("item/completed", { item }));
    }

    events.push({
      type: "turn_ended",
      stopped: turn.status === "interrupted",
      ...(typeof turn.durationMs === "number" ? { durationMs: turn.durationMs } : {}),
    });
  }
  return events;
}
