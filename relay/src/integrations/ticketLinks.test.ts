// The work-ticket links against a store kept in memory and a clock written
// here. Pure — no file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TicketLinks, parseTicketLinksFile, ticketLinksPathFor, type TicketLinkEvent, type TicketLinksStore } from "./ticketLinks.js";
import type { TicketRef, WorkTicket } from "./types.js";

const NOW = 1_793_320_000_000;
const SITE = "00000000-0000-4000-8000-000000000001";
const ticket = (key: string): TicketRef => ({ provider: "jira", site: SITE, key });

class MemoryStore implements TicketLinksStore {
  saved: Record<string, WorkTicket> | undefined;
  constructor(initial?: Record<string, WorkTicket>) {
    this.saved = initial;
  }
  load() {
    return this.saved ? structuredClone(this.saved) : undefined;
  }
  save(bySession: Record<string, WorkTicket>) {
    this.saved = structuredClone(bySession);
  }
}

function harness(sessions: string[] = ["s1", "s2"], store = new MemoryStore()) {
  const links = new TicketLinks({ store, now: () => NOW, sessionExists: (id) => sessions.includes(id) });
  const events: TicketLinkEvent[] = [];
  links.subscribe((event) => events.push(event));
  return { links, store, events };
}

test("a session gets one ticket: a second link is a conflict, and unlink frees it", () => {
  const { links, events } = harness();
  assert.equal(links.link("s1", ticket("NGL-1"), "manual", { title: "Fix the login", lineDue: true }), "ok");
  assert.equal(links.link("s1", ticket("NGL-2"), "mcp"), "conflict");
  assert.equal(links.get("s1")?.ticket.key, "NGL-1");
  // A ticket may have several sessions.
  assert.equal(links.link("s2", ticket("NGL-1"), "start"), "ok");
  assert.deepEqual(links.get("s1"), { sessionId: "s1", ticket: ticket("NGL-1"), origin: "manual", linkedAt: NOW, title: "Fix the login", lineDue: true });

  assert.equal(links.unlink("s1"), true);
  assert.equal(links.unlink("s1"), false);
  assert.equal(links.link("s1", ticket("NGL-2"), "mcp", { evidence: "getJiraIssue" }), "ok");
  assert.deepEqual(
    events.map((event) => (event.type === "work_ticket_upsert" ? `+${event.link.sessionId}:${event.link.ticket.key}` : `-${event.sessionId}`)),
    ["+s1:NGL-1", "+s2:NGL-1", "-s1", "+s1:NGL-2"],
  );
});

test("a session that does not exist gets no ticket", () => {
  const { links, events } = harness();
  assert.equal(links.link("ghost", ticket("NGL-1"), "manual"), "no_session");
  assert.equal(events.length, 0);
});

test("the due line is taken once, and an unlink before it is taken drops it", () => {
  const { links } = harness();
  links.link("s1", ticket("NGL-7"), "manual", { lineDue: true });
  assert.equal(links.takeDueLine("s1")?.key, "NGL-7");
  assert.equal(links.takeDueLine("s1"), undefined);
  assert.equal(links.get("s1")?.lineDue, false);

  links.link("s2", ticket("NGL-8"), "manual", { lineDue: true });
  links.unlink("s2");
  assert.equal(links.takeDueLine("s2"), undefined);
  // An mcp link never has one: the agent opened the ticket itself.
  links.link("s2", ticket("NGL-9"), "mcp");
  assert.equal(links.takeDueLine("s2"), undefined);
});

test("links survive in the store, and those of sessions gone are dropped on load", () => {
  const store = new MemoryStore();
  const first = harness(["s1", "s2"], store);
  first.links.link("s1", ticket("NGL-1"), "manual");
  first.links.link("s2", ticket("NGL-2"), "start");
  const second = harness(["s2"], store);
  assert.deepEqual(second.links.list().map((link) => link.sessionId), ["s2"]);
  assert.deepEqual(Object.keys(store.saved ?? {}), ["s2"]);
});

test("the file is read back field by field; another version or a bad entry is dropped", () => {
  const link = { ticket: ticket("NGL-1"), origin: "manual", linkedAt: NOW, lineDue: true, title: "Fix", evidence: "", place: { roomId: "r" } };
  assert.deepEqual(parseTicketLinksFile(JSON.stringify({ version: 1, bySession: { s1: link, s2: { ...link, ticket: { ...link.ticket, key: "nope" } }, s3: { ...link, origin: "other" } } })), {
    s1: { sessionId: "s1", ticket: ticket("NGL-1"), origin: "manual", linkedAt: NOW, title: "Fix", lineDue: true },
  });
  assert.equal(parseTicketLinksFile(JSON.stringify({ version: 2, bySession: {} })), undefined);
  assert.equal(parseTicketLinksFile("not json"), undefined);
  assert.equal(ticketLinksPathFor("/x/pessoal.json"), "/x/pessoal-ticket-links.json");
});

test("a session that may not hold a ticket (a room's principal) is refused as a conflict", () => {
  const links = new TicketLinks({ now: () => NOW, mayHold: (id) => id !== "principal" });
  assert.equal(links.link("principal", ticket("NGL-9"), "manual"), "conflict");
  assert.equal(links.get("principal"), undefined);
  assert.equal(links.link("worker", ticket("NGL-9"), "delegate"), "ok");
});

test("a room agent's place is announced when it changes, and only then", () => {
  const { links, store, events } = harness(["w1", "s2"]);
  const place = { roomId: "r1", roomTitle: "Release", agentTitle: "Fixer", agentState: "queued" };
  assert.equal(links.link("w1", ticket("NGL-9"), "delegate", { place }), "ok");
  assert.deepEqual(links.get("w1")?.place, place);
  events.length = 0;
  links.setPlace("w1", { ...place });
  assert.equal(events.length, 0, "unchanged: nothing announced");
  links.setPlace("w1", { ...place, agentState: "working" });
  assert.deepEqual(events.map((event) => event.type === "work_ticket_upsert" && event.link.place?.agentState), ["working"]);
  assert.equal(store.saved?.w1?.place?.agentState, "working");
  links.setPlace("w1", undefined);
  assert.equal(links.get("w1")?.place, undefined);
  // No link, nothing to place.
  links.setPlace("s2", place);
  assert.equal(links.get("s2"), undefined);
});
