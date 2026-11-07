// The line that tells an agent which ticket its session works on. The
// relay puts it at the start of the prompt of the turn that should know
// (a session started from a ticket, the person's next message after
// attaching one) — `Jira ticket: NGL-1144`, a blank line, then what the
// person typed. What people are shown never has it: the live bubble is the
// typed text already, and the history rebuilt from the agent CLI's own
// transcript (which keeps only the prompt) drops it again.
//
// A room's principal is handed a ticket to pass on instead
// (`Jira ticket to delegate: NGL-9`); the same strip removes both forms.
// Order in a prompt: this line, the body, the room card, the relay notes.
import type { IntegrationProvider } from "../integrations/types.js";

const LABELS: Record<IntegrationProvider, string> = { jira: "Jira ticket", linear: "Linear issue" };

/** `work`: the session works on it; `delegate`: a principal passes it on. */
export type TicketLineKind = "work" | "delegate";

/** A ticket line a turn's prompt is to start with. */
export interface TicketLine {
  readonly provider: IntegrationProvider;
  readonly key: string;
  readonly kind: TicketLineKind;
}

const label = (provider: IntegrationProvider, kind: TicketLineKind): string => `${LABELS[provider]}${kind === "delegate" ? " to delegate" : ""}`;

export function withTicketLine(text: string, key: string, provider: IntegrationProvider = "jira", kind: TicketLineKind = "work"): string {
  return `${label(provider, kind)}: ${key}\n\n${text}`;
}

const LINE = new RegExp(`^(?:${Object.values(LABELS).join("|")})(?: to delegate)?: [A-Z][A-Z0-9]{1,9}-\\d{1,7}\\n\\n`);

/** The text without the ticket line at its start; unchanged unless it
 * starts with exactly a line the relay writes. Only the first one goes. */
export function stripTicketLine(text: string): string {
  const match = LINE.exec(text);
  return match ? text.slice(match[0].length) : text;
}
