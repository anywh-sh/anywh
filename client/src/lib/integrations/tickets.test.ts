import { describe, expect, it } from "vitest";
import { mineQuery, priorityLevel, projectOptions, queryCooldown, queryView, rowFromLists, ticketView, visibleRows } from "@/lib/integrations/tickets";
import type { IntegrationState, QueryState, TicketRow } from "@/lib/integrations/model";

function row(key: string, patch: Partial<TicketRow> = {}): TicketRow {
  return { key, id: key, title: key, statusCategory: "todo", statusLabel: "To Do", project: key.split("-")[0], updatedAt: 0, url: "", ...patch };
}

function jira(queries: QueryState[], project: string | null = null): IntegrationState {
  return { id: "jira", provider: "jira", runtimes: [], prefs: { project }, queries };
}

const mine = (param: string | null, items: TicketRow[]): QueryState => ({ query: "mine", param, items, status: "ok", reading: false, observedAt: 1 });

describe("tickets", () => {
  it("finds a list by project and leaves done tickets out", () => {
    const integration = jira([mine(null, [row("A-1"), row("A-2", { statusCategory: "done" })]), mine("B", [row("B-1")])]);
    expect(visibleRows(mineQuery(integration, null)).map((item) => item.key)).toEqual(["A-1"]);
    expect(mineQuery(integration, "B")?.param).toBe("B");
    expect(mineQuery(integration, "C")).toBeUndefined();
  });

  it("offers every cached project plus the remembered one, sorted", () => {
    expect(projectOptions(jira([mine(null, [row("NGL-1"), row("ANY-2")]), mine("NGL", [row("NGL-1")])], "OPS"))).toEqual(["ANY", "NGL", "OPS"]);
    expect(projectOptions(undefined)).toEqual([]);
  });

  it("shows a ticket from its own read, else from a list", () => {
    const integration = jira([mine(null, [row("A-1", { title: "from list" })])]);
    expect(rowFromLists(integration, "A-1")?.title).toBe("from list");
    expect(ticketView(integration, "A-1")).toEqual({ row: row("A-1", { title: "from list" }) });
    const detail = { ...row("A-1", { title: "read" }), comments: [] };
    const read = jira([...integration.queries, { query: "ticket", param: "A-1", detail, status: "ok", reading: false, observedAt: 1 }]);
    expect(ticketView(read, "A-1").detail?.title).toBe("read");
  });

  it("tells loading, failure and data apart; data wins over a failed refresh", () => {
    expect(queryView(undefined)).toBe("loading");
    expect(queryView({ query: "mine", param: null, status: "unknown", reading: true })).toBe("loading");
    expect(queryView({ query: "mine", param: null, status: "error", reading: false })).toBe("error");
    expect(queryView({ query: "mine", param: null, status: "needs_auth", reading: false })).toBe("needs_auth");
    expect(queryView({ query: "mine", param: null, status: "error", reading: false, observedAt: 1, items: [] })).toBe("ready");
  });

  it("holds a forced refresh until refreshableAt", () => {
    const query: QueryState = { query: "mine", param: null, status: "ok", reading: false, refreshableAt: 10_000 };
    expect(queryCooldown(query, 4_000)).toBe(6_000);
    expect(queryCooldown(query, 10_000)).toBeNull();
    expect(queryCooldown(undefined, 0)).toBeNull();
  });

  it("maps priority words to a level", () => {
    expect(priorityLevel("Highest")).toBe("highest");
    expect(priorityLevel(" high ")).toBe("high");
    expect(priorityLevel("Medium")).toBe("medium");
    expect(priorityLevel("Lowest")).toBe("lowest");
    expect(priorityLevel("P2")).toBe("none");
    expect(priorityLevel(undefined)).toBe("none");
  });
});
