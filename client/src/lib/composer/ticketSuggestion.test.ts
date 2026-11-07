import { describe, expect, it } from "vitest";
import { EMPTY_PROFILE_INTEGRATIONS, type ProfileIntegrations } from "@/lib/integrations/derive";
import type { IntegrationState, TicketRow } from "@/lib/integrations/model";
import { TICKET_PICK_LIMIT, enterPicks, ticketPickItems, type TicketPickSource } from "./ticketSuggestion";

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

  it("offers Connect only after the bare #, so #123 stays text", () => {
    expect(ticketPickItems(source([]), "123")).toEqual([]);
    expect(ticketPickItems(source([]), "fix")).toEqual([]);
  });

  it("offers Connect only once the relay said so live, never while connecting, offline or without a socket", () => {
    expect(ticketPickItems(source(null, {}, "connecting"), "")).toEqual([]);
    expect(ticketPickItems(source([], {}, "offline"), "")).toEqual([]);
    expect(ticketPickItems(source(null, {}, "offline"), "")).toEqual([]);
  });

  it("matches a number alone against the start of the key's number, not inside it or the title", () => {
    const numbered = [row("NGL-12", "Filter by date"), row("NGL-120", "Orders"), row("NGL-312", "Version 12"), row("ABC-1", "Other")];
    expect(keys(ticketPickItems(source([jira(numbered)]), "12"))).toEqual(["NGL-12", "NGL-120"]);
    expect(keys(ticketPickItems(source([jira(numbered)]), "1"))).toEqual(["NGL-12", "NGL-120", "ABC-1"]);
    expect(keys(ticketPickItems(source([jira(numbered)]), "gl-31"))).toEqual(["NGL-312"]);
  });

  it("offers nothing on a relay that does not know integrations", () => {
    expect(ticketPickItems(source(null, {}, "unsupported"), "")).toEqual([]);
    expect(ticketPickItems({ entry: undefined, workTicket: undefined, canConnect: true }, "")).toEqual([]);
  });
});

describe("enterPicks", () => {
  const ticket = { kind: "ticket" as const, provider: "jira" as const, site: "s", key: "NGL-12", title: "t" };
  const connect = { kind: "connect" as const, provider: "jira" as const };

  it("never lets Connect take Enter", () => {
    expect(enterPicks([connect], 0, "", true)).toBe(false);
  });

  it("takes Enter for a ticket after text, and after a number only once the selection moved", () => {
    expect(enterPicks([ticket], 0, "filter", false)).toBe(true);
    expect(enterPicks([ticket], 0, "12", false)).toBe(false);
    expect(enterPicks([ticket], 0, "12", true)).toBe(true);
    expect(enterPicks([], 0, "", false)).toBe(false);
  });
});
