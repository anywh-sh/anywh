import { describe, expect, it } from "vitest";
import type { IntegrationState, WorkTicket } from "@/lib/integrations/model";
import { canWorkHere, chipsOf, isTicketRef, isWorkTicket, linksOnTicket, sessionTicket, ticketRefFor, ticketTagOf, withValidWorkTicket } from "@/lib/integrations/workTickets";

function link(sessionId: string, key: string, linkedAt: number): WorkTicket {
  return { sessionId, ticket: { provider: "jira", site: "cloud-1", key }, origin: "manual", linkedAt, lineDue: false };
}

describe("work tickets", () => {
  it("accepts only a ticket the relay would accept", () => {
    expect(isTicketRef({ provider: "jira", site: "cloud-1", key: "NGL-1144" })).toBe(true);
    expect(isTicketRef({ provider: "jira", site: "", key: "NGL-1144" })).toBe(false);
    expect(isTicketRef({ provider: "jira", site: "cloud-1", key: "ngl-1" })).toBe(false);
    expect(isTicketRef({ provider: "github", site: "cloud-1", key: "NGL-1" })).toBe(false);
    expect(ticketTagOf({ provider: "jira", key: "NGL-7", extra: 1 })).toEqual({ provider: "jira", key: "NGL-7" });
    expect(ticketTagOf("NGL-7")).toBeUndefined();
    expect(isWorkTicket(link("s", "NGL-1", 1))).toBe(true);
    expect(isWorkTicket({ ...link("s", "NGL-1", 1), ticket: { provider: "jira", key: "NGL-1" } })).toBe(false);
  });

  it("lists a ticket's sessions, the latest linked first", () => {
    const links = { a: link("a", "NGL-1", 1), b: link("b", "NGL-2", 5), c: link("c", "NGL-1", 3) };
    expect(linksOnTicket(links, { provider: "jira", key: "NGL-1" }).map((entry) => entry.sessionId)).toEqual(["c", "a"]);
    expect(linksOnTicket(null, { provider: "jira", key: "NGL-1" })).toEqual([]);
    expect(chipsOf(["c", "a", "x"], 2)).toEqual({ shown: ["c", "a"], more: 1 });
  });

  it("offers the current session only when it exists and works on no ticket", () => {
    const links = { busy: link("busy", "NGL-1", 1) };
    expect(canWorkHere(links, "free")).toBe(true);
    expect(canWorkHere(links, "busy")).toBe(false);
    expect(canWorkHere(links, null)).toBe(false);
    // The relay has not said which sessions are free.
    expect(canWorkHere(null, "free")).toBe(false);
  });

  it("reads a session's ticket from the integrations socket once it has spoken, else from the session list", () => {
    const fromList = { provider: "jira" as const, key: "NGL-9" };
    expect(sessionTicket(null, "s", fromList)).toEqual(fromList);
    expect(sessionTicket({}, "s", fromList)).toBeUndefined();
    expect(sessionTicket({ s: { ...link("s", "NGL-1", 1), title: "Paginate" } }, "s", fromList)).toEqual({ provider: "jira", key: "NGL-1", title: "Paginate" });
  });

  it("needs the site before a ticket can be sent", () => {
    const integration = { id: "jira", provider: "jira", runtimes: [], prefs: { project: null }, queries: [] } as IntegrationState;
    expect(ticketRefFor(integration, "NGL-1")).toBeNull();
    expect(ticketRefFor({ ...integration, site: { id: "cloud-1", url: "https://acme.atlassian.net", name: "acme" } }, "NGL-1")).toEqual({ provider: "jira", site: "cloud-1", key: "NGL-1" });
  });
});

describe("a session row's work ticket", () => {
  it("is kept only when well formed", () => {
    const row = { id: "s", title: "S", lastActiveAt: 1 };
    expect(withValidWorkTicket({ ...row, workTicket: { provider: "jira", key: "NGL-1" } })).toEqual({ ...row, workTicket: { provider: "jira", key: "NGL-1" } });
    expect(withValidWorkTicket({ ...row, workTicket: { provider: "jira", key: "nope" } } as never)).toEqual(row);
    expect(withValidWorkTicket(row)).toBe(row);
  });
});
