import type { RoomCard } from "./agent-event.js";

// The card a room turn is shown as. Chat history is rebuilt from the agent
// CLI's own transcript, which keeps nothing but the prompt, so the card rides
// at the end of the prompt as one JSON line behind a marker (like the relay
// note) and is split off again for display, live and on replay. Order in the
// prompt: body, card, relay notes.
const ROOM_CARD_MARKER = "\n\n[anywh-card] ";
const VERSION = 1;
const MAX_TITLE = 120;

function clipTitle(title: string | null): string | null {
  if (title === null) return null;
  const line = title.replace(/\s+/g, " ").trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

/** The prompt with `card` appended as its final line. */
export function withRoomCard(text: string, card: RoomCard): string {
  const clean: RoomCard =
    card.kind === "instruction"
      ? { kind: "instruction", title: clipTitle(card.title) }
      : { kind: "reports", reports: card.reports.map((r) => ({ ...r, title: clipTitle(r.title) })) };
  return `${text}${ROOM_CARD_MARKER}${JSON.stringify({ v: VERSION, ...clean })}`;
}

/** Strict runtime check of a card (not of its `v`). */
export function isRoomCard(value: unknown): value is RoomCard {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const title = (t: unknown) => t === null || typeof t === "string";
  if (v.kind === "instruction") return title(v.title);
  if (v.kind !== "reports" || !Array.isArray(v.reports)) return false;
  return v.reports.every((r) => {
    if (typeof r !== "object" || r === null) return false;
    const o = r as Record<string, unknown>;
    return (
      typeof o.agentId === "string" &&
      title(o.title) &&
      (o.status === "done" || o.status === "failed" || o.status === "blocked") &&
      typeof o.at === "number" &&
      Number.isFinite(o.at)
    );
  });
}

/** The text without its card line, and the card. Only a marker that ENDS the
 * text, followed by one valid v1 card, counts; anything else (a person's own
 * text that happens to contain the marker) comes back untouched. */
export function splitRoomCard(text: string): { text: string; card?: RoomCard } {
  const at = text.lastIndexOf(ROOM_CARD_MARKER);
  if (at < 0) return { text };
  const json = text.slice(at + ROOM_CARD_MARKER.length);
  if (json.includes("\n")) return { text };
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return { text };
    const { v, ...card } = parsed as Record<string, unknown>;
    if (v !== VERSION || !isRoomCard(card)) return { text };
    return { text: text.slice(0, at), card };
  } catch {
    return { text };
  }
}
