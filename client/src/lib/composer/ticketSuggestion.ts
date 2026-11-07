import { Node, mergeAttributes } from "@tiptap/core";
import type { IntegrationProvider, IntegrationState, TicketTag } from "@/lib/integrations/model";
import { pickFetchRuntime, railIntegrations } from "@/lib/integrations/derive";
import type { ProfileIntegrations } from "@/lib/integrations/derive";
import { mineQuery, ticketView, visibleRows } from "@/lib/integrations/tickets";
import { HARD_BREAK_ANCHOR } from "@/lib/composer/composerLinks";

/**
 * `#` in the composer: a ticket of the profile's tracker becomes a chip in
 * the text, and the message carries just its key. Context only — nothing is
 * linked and no field is added to the message.
 */

/** What the `#` menu offers. */
export type TicketPickItem =
  | { kind: "ticket"; provider: IntegrationProvider; site: string; key: string; title: string; statusLabel?: string }
  /** The profile has no tracker the menu can read: the way to connect one. */
  | { kind: "connect"; provider: IntegrationProvider };

/** How many tickets the menu lists at once. */
export const TICKET_PICK_LIMIT = 8;

/** The provider the menu reads; one tracker per profile in this version. */
const PICK_PROVIDER: IntegrationProvider = "jira";

/** What the menu is built from: the profile's integrations (`undefined`
 * where there is no socket, as on a relay that predates them) and the
 * session's work ticket. */
export interface TicketPickSource {
  entry: ProfileIntegrations | undefined;
  workTicket: TicketTag | undefined;
  /** Whether "Connect" can be offered (the shell's connect card is there). */
  canConnect: boolean;
}

/**
 * The menu's items for a query: with none, the session's work ticket first,
 * then the person's open tickets as the cache has them ("All mine"); with
 * one, those whose key or title has it. A profile where no agent can read
 * the tracker and nothing is cached gets "Connect" instead; a relay that
 * does not know integrations gets nothing (no menu). Pure.
 */
export function ticketPickItems(source: TicketPickSource, query: string): TicketPickItem[] {
  const { entry } = source;
  if (!entry || entry.connection === "unsupported" || entry.connection === "revoked") return [];
  const integration: IntegrationState | undefined = railIntegrations(entry).find((item) => item.provider === PICK_PROVIDER);
  const site = integration?.site?.id ?? "";
  const tickets: TicketPickItem[] = [];
  const seen = new Set<string>();
  const add = (key: string, title: string, statusLabel?: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    tickets.push({ kind: "ticket", provider: PICK_PROVIDER, site, key, title, ...(statusLabel ? { statusLabel } : {}) });
  };
  if (integration) {
    const work = source.workTicket?.provider === PICK_PROVIDER ? source.workTicket : undefined;
    if (work) {
      const { row } = ticketView(integration, work.key);
      add(work.key, row?.title ?? "", row?.statusLabel);
    }
    for (const row of visibleRows(mineQuery(integration, null))) add(row.key, row.title, row.statusLabel);
  }
  const canRead = integration !== undefined && pickFetchRuntime(integration) !== undefined;
  if (tickets.length === 0 && !canRead) return source.canConnect ? [{ kind: "connect", provider: PICK_PROVIDER }] : [];
  const needle = query.trim().toLowerCase();
  const matching = needle === "" ? tickets : tickets.filter((item) => item.kind === "ticket" && (item.key.toLowerCase().includes(needle) || item.title.toLowerCase().includes(needle)));
  return matching.slice(0, TICKET_PICK_LIMIT);
}

/** What may stand right before `#` for it to open the menu: a space, or
 * nothing (start of the line — Suggestion reads that as `\0`); the composer's
 * line anchor counts as nothing. Never a letter, so `C#` stays text. */
export const TICKET_ALLOWED_PREFIXES = [" ", HARD_BREAK_ANCHOR];

/**
 * A ticket in the composer: one atomic piece (Backspace takes it whole)
 * showing the key, with the tracker, site and title kept for the chip's
 * tooltip. It serializes to just the key.
 */
export const TicketChipNode = Node.create({
  name: "ticketChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      provider: { default: PICK_PROVIDER },
      site: { default: "" },
      key: { default: "" },
      title: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-ticket-chip]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { key, title, provider } = node.attrs as { key: string; title: string; provider: string };
    return ["span", mergeAttributes(HTMLAttributes, { "data-ticket-chip": key, "data-provider": provider, class: "composer-ticket-chip", title: title || key, contenteditable: "false" }), key];
  },
  renderText({ node }) {
    return (node.attrs as { key: string }).key;
  },
});
