import type { IntegrationState, QueryState, TicketDetail, TicketRow } from "@/lib/integrations/model";

/**
 * What an integration's pane shows of its tickets, derived from the relay's
 * cached queries. Pure: the pane owns the socket and the layout.
 */

export type MineQuery = Extract<QueryState, { query: "mine" }>;
export type TicketQuery = Extract<QueryState, { query: "ticket" }>;

/** The cached "assigned to me" list for one project (`null`: every one). */
export function mineQuery(integration: IntegrationState | undefined, project: string | null): MineQuery | undefined {
  return integration?.queries.find((query): query is MineQuery => query.query === "mine" && query.param === project);
}

/** The cached screen of one ticket. */
export function ticketQuery(integration: IntegrationState | undefined, key: string): TicketQuery | undefined {
  return integration?.queries.find((query): query is TicketQuery => query.query === "ticket" && query.param === key);
}

/** The rows a list shows: what is not done, in the relay's order. The relay
 * already leaves done tickets out; a row that turned done since (an agent
 * moved it) goes too. */
export function visibleRows(query: MineQuery | undefined): TicketRow[] {
  return (query?.items ?? []).filter((row) => row.statusCategory !== "done");
}

/** One status's rows of a list, under its heading. */
export interface StatusGroup {
  label: string;
  rows: TicketRow[];
}

const CATEGORY_ORDER: Record<TicketRow["statusCategory"], number> = { doing: 0, todo: 1, done: 2 };

/** A list's rows by status, as its headings show them: what is in progress
 * before what is still to do, and the statuses of one category in the order
 * the list first meets them. Rows keep the list's order inside a group. */
export function groupByStatus(rows: readonly TicketRow[]): StatusGroup[] {
  const groups = new Map<string, StatusGroup & { category: number; first: number }>();
  rows.forEach((row, index) => {
    const group = groups.get(row.statusLabel);
    if (group) group.rows.push(row);
    else groups.set(row.statusLabel, { label: row.statusLabel, rows: [row], category: CATEGORY_ORDER[row.statusCategory], first: index });
  });
  return [...groups.values()].sort((a, b) => a.category - b.category || a.first - b.first).map(({ label, rows: grouped }) => ({ label, rows: grouped }));
}

/** The projects the dropdown offers: every project seen in any cached list,
 * plus the remembered one even when no list has it yet. Sorted, so the menu
 * does not reorder as pages arrive. */
export function projectOptions(integration: IntegrationState | undefined): string[] {
  const projects = new Set<string>();
  for (const query of integration?.queries ?? []) {
    if (query.query !== "mine") continue;
    for (const row of query.items ?? []) projects.add(row.project);
  }
  const remembered = integration?.prefs.project;
  if (remembered) projects.add(remembered);
  return [...projects].sort((a, b) => a.localeCompare(b));
}

/** A ticket as far as the lists know it, for its screen to show something
 * before its own read lands. */
export function rowFromLists(integration: IntegrationState | undefined, key: string): TicketRow | undefined {
  for (const query of integration?.queries ?? []) {
    if (query.query !== "mine") continue;
    const row = query.items?.find((item) => item.key === key);
    if (row) return row;
  }
  return undefined;
}

/** The best of what is known about a ticket: its own read, else its row. */
export function ticketView(integration: IntegrationState | undefined, key: string): { detail?: TicketDetail; row?: TicketRow } {
  const detail = ticketQuery(integration, key)?.detail;
  return detail ? { detail, row: detail } : { row: rowFromLists(integration, key) };
}

/**
 * What a query's part of the pane is:
 * - `loading`: nothing to show yet, a read is (or is about to be) under way.
 * - `needs_auth`: nothing to show, the read wants a sign-in.
 * - `error`: nothing to show, the read failed.
 * - `ready`: data to show (a failed or refused refresh keeps it, with a note).
 */
export type QueryView = "loading" | "needs_auth" | "error" | "ready";

export function queryView(query: QueryState | undefined): QueryView {
  if (query?.observedAt !== undefined) return "ready";
  if (!query || query.reading) return "loading";
  if (query.status === "needs_auth") return "needs_auth";
  if (query.status === "error") return "error";
  return "loading";
}

/** How long until a forced refresh of the query reads again, in ms; `null`
 * when it can now. The relay's `refreshableAt` is its own clock, used as is. */
export function queryCooldown(query: QueryState | undefined, nowMs: number): number | null {
  if (query?.refreshableAt === undefined) return null;
  const remaining = query.refreshableAt - nowMs;
  return remaining > 0 ? remaining : null;
}

/** The priority words every tracker in use writes, mapped to a level for the
 * row's mark; anything else draws as neutral. */
export type PriorityLevel = "highest" | "high" | "medium" | "low" | "lowest" | "none";

export function priorityLevel(priority: string | undefined): PriorityLevel {
  switch ((priority ?? "").trim().toLowerCase()) {
    case "highest":
    case "blocker":
    case "critical":
    case "urgent":
      return "highest";
    case "high":
    case "major":
      return "high";
    case "medium":
    case "normal":
      return "medium";
    case "low":
    case "minor":
      return "low";
    case "lowest":
    case "trivial":
      return "lowest";
    default:
      return "none";
  }
}
