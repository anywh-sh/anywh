import { describe, expect, it } from "vitest";
import { EMPTY_PROFILE_INTEGRATIONS, type ProfileIntegrations } from "@/lib/integrations/derive";
import type { IntegrationState, TicketRow } from "@/lib/integrations/model";
import { TICKET_PICK_LIMIT, ticketPickItems, type TicketPickSource } from "./ticketSuggestion";

function row(key: string, title: string, statusCategory: TicketRow["statusCategory"] = "todo"): TicketRow {
  return { key, id: key, title, statusCategory, statusLabel: "To Do", priority: "Medium", project: "NGL", updatedAt: 0, url: "" };
}

function jira(items: TicketRow[], over: Partial<IntegrationState> = {}): IntegrationState {
  return {
    id: "jira",
    provider: "jira",
    runtimes: [{ runtimeId: "claude", serverName: "atlassian", scope: "user", status: "connected", authMode: "oauth", alternatives: 0 }],
    fetchRuntime: "claude",
    site: { id: "cloud-1", url: "https://acme.atlassian.net", name: "acme" },
    prefs: { project: null },
    queries: [{ query: "mine", param: null, items, status: "ok", reading: false, observedAt: 0, source: "open" }],
    ...over,
  };
}

function source(integrations: IntegrationState[] | null, extra: Partial<TicketPickSource> = {}, connection: ProfileIntegrations["connection"] = "live"): TicketPickSource {
  return { entry: { ...EMPTY_PROFILE_INTEGRATIONS, connection, integrations }, workTicket: undefined, canConnect: true, ...extra };
}

const keys = (items: ReturnType<typeof ticketPickItems>) => items.map((item) => (item.kind === "ticket" ? item.key : item.kind));

describe("ticketPickItems", () => {
  const rows = [row("NGL-1", "Filter by date"), row("NGL-2", "Orders pagination"), row("NGL-3", "Shipped", "done")];

  it("lists the work ticket first, then the open tickets of All mine, without duplicates", () => {
    expect(keys(ticketPickItems(source([jira(rows)], { workTicket: { provider: "jira", key: "NGL-2" } }), ""))).toEqual(["NGL-2", "NGL-1"]);
  });

  it("filters by key or title, ignoring case", () => {
    expect(keys(ticketPickItems(source([jira(rows)]), "PAGIN"))).toEqual(["NGL-2"]);
    expect(keys(ticketPickItems(source([jira(rows)]), "ngl-1"))).toEqual(["NGL-1"]);
    expect(ticketPickItems(source([jira(rows)]), "nothing")).toEqual([]);
  });

  it("carries the site and title a chip keeps", () => {
    expect(ticketPickItems(source([jira(rows)]), "NGL-1")[0]).toEqual({ kind: "ticket", provider: "jira", site: "cloud-1", key: "NGL-1", title: "Filter by date", statusLabel: "To Do" });
  });

  it("caps the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => row(`NGL-${String(i + 10)}`, `t${String(i)}`));
    expect(ticketPickItems(source([jira(many)]), "")).toHaveLength(TICKET_PICK_LIMIT);
  });

  it("offers Connect where no agent can read the tracker and nothing is cached", () => {
    expect(keys(ticketPickItems(source([]), ""))).toEqual(["connect"]);
    const signedOut = jira([], { fetchRuntime: undefined, runtimes: [{ runtimeId: "claude", serverName: "atlassian", scope: "user", status: "needs_auth", authMode: "oauth", alternatives: 0 }] });
    expect(keys(ticketPickItems(source([signedOut]), ""))).toEqual(["connect"]);
    expect(ticketPickItems(source([], { canConnect: false }), "")).toEqual([]);
  });

  it("offers nothing on a relay that does not know integrations", () => {
    expect(ticketPickItems(source(null, {}, "unsupported"), "")).toEqual([]);
    expect(ticketPickItems({ entry: undefined, workTicket: undefined, canConnect: true }, "")).toEqual([]);
  });
});
