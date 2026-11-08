import { Node, mergeAttributes } from "@tiptap/core";
import type { IntegrationProvider, IntegrationState, TicketTag } from "@/lib/integrations/model";
import { integrationDataState, pickFetchRuntime, railIntegrations } from "@/lib/integrations/derive";
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
 * one, those whose key or title has it — a number alone (`#12`) only the
 * keys whose number starts with it, never a title or another key's middle.
 * A profile the relay says no agent can read the tracker of, with nothing
 * cached, gets "Connect" — and only right after the bare `#`, so `#123`
 * stays text there; while the state is not live (connecting, offline,
 * no socket at all) nothing is offered. A relay that does not know
 * integrations gets nothing (no menu). Pure.
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
  const needle = query.trim().toLowerCase();
  if (tickets.length === 0 && !canRead) {
    const offerConnect = source.canConnect && needle === "" && integrationDataState(entry) === "live";
    return offerConnect ? [{ kind: "connect", provider: PICK_PROVIDER }] : [];
  }
  const matching = needle === "" ? tickets : tickets.filter((item) => item.kind === "ticket" && matchesTicket(item, needle));
  return matching.slice(0, TICKET_PICK_LIMIT);
}

/** A number alone, as in GitHub's `#12`. */
const NUMBER_ONLY = /^\d+$/;

function matchesTicket(item: { key: string; title: string }, needle: string): boolean {
  if (NUMBER_ONLY.test(needle)) return (item.key.split("-").pop() ?? "").startsWith(needle);
  return item.key.toLowerCase().includes(needle) || item.title.toLowerCase().includes(needle);
}

/**
 * Whether Enter (or Tab) takes the menu's selected item rather than sending
 * the message, and so whether that item is drawn as selected. Never
 * "Connect" (Enter after a lone `#` sends it); and after a number alone only
 * once the person moved the selection with the arrows, so a GitHub-style
 * `#12` + Enter still sends `#12`. A click always picks. Pure.
 */
export function enterPicks(items: TicketPickItem[], selectedIndex: number, query: string, selectionMoved: boolean): boolean {
  const item = items[selectedIndex] as TicketPickItem | undefined;
  if (item?.kind !== "ticket") return false;
  return selectionMoved || !NUMBER_ONLY.test(query.trim());
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
