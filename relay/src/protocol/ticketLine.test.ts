import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTicketLine, withTicketLine } from "./ticketLine.js";
import { splitRoomCard, withRoomCard } from "./roomCard.js";
import { WITHDRAWN_APPROVAL_NOTE, stripRelayNote, withRelayNote } from "./relayNote.js";

test("the line goes first, and only it is stripped", () => {
  assert.equal(withTicketLine("fix the login", "NGL-1144"), "Jira ticket: NGL-1144\n\nfix the login");
  assert.equal(stripTicketLine(withTicketLine("fix the login", "NGL-1144")), "fix the login");
  // Any message can carry it, the text after it comes back as it was.
  assert.equal(stripTicketLine(withTicketLine("  two\n\nparagraphs  ", "AB-1")), "  two\n\nparagraphs  ");
  assert.equal(stripTicketLine(withTicketLine("", "NGL-7")), "");
});

test("the principal's form is stripped too", () => {
  const carried = withTicketLine("split this up", "NGL-9", "jira", "delegate");
  assert.equal(carried, "Jira ticket to delegate: NGL-9\n\nsplit this up");
  assert.equal(stripTicketLine(carried), "split this up");
});

test("text without the exact line comes back untouched", () => {
  for (const text of [
    "fix the login",
    "about Jira ticket: NGL-1\n\nlater",
    " Jira ticket: NGL-1\n\nleading space",
    "Jira ticket: NGL-1\nonly one newline",
    "Jira ticket: ngl-1\n\nlowercase key",
    "Jira ticket: NGL-12345678\n\ntoo many digits",
    "Jira ticket: NGL-1",
  ]) {
    assert.equal(stripTicketLine(text), text, JSON.stringify(text));
  }
  // Only the first one: a second line is the person's own text.
  assert.equal(stripTicketLine("Jira ticket: NGL-1\n\nJira ticket: NGL-2\n\nhi"), "Jira ticket: NGL-2\n\nhi");
});

test("with a room card and a relay note: line, body, card, notes — each removed by its own", () => {
  const card = { kind: "instruction" as const, title: "Write the docs" };
  const prompt = withRelayNote(withRoomCard(withTicketLine("Write the docs.", "NGL-9"), card), WITHDRAWN_APPROVAL_NOTE);
  const split = splitRoomCard(stripRelayNote(prompt));
  assert.deepEqual(split.card, card);
  assert.equal(stripTicketLine(split.text), "Write the docs.");
});
