import { test } from "node:test";
import assert from "node:assert/strict";
import { withRelayNote, stripRelayNote, WITHDRAWN_APPROVAL_NOTE } from "./relayNote.js";
import type { RoomCard } from "./agent-event.js";
import { isRoomCard, splitRoomCard, withRoomCard } from "./roomCard.js";

const reports: RoomCard = {
kind: "reports",
reports: [
  { agentId: "a1", title: "Fix login", status: "done", at: 1000 },
  { agentId: "a2", title: null, status: "blocked", at: 2000 },
],
};
const instruction: RoomCard = { kind: "instruction", title: "Write the docs" };

test("room card: round-trips both forms", () => {
  for (const card of [reports, instruction]) {
    assert.deepEqual(splitRoomCard(withRoomCard("body\nmore", card)), { text: "body\nmore", card });
  }
});

test("room card: limits and flattens the title", () => {
  const { card } = splitRoomCard(withRoomCard("x", { kind: "instruction", title: `a\n${"b".repeat(300)}` }));
  assert.equal(card?.kind === "instruction" && card.title?.length, 120);
  assert.ok(!(card?.kind === "instruction" && card.title?.includes("\n")));
});

test("room card: returns a person's text untouched", () => {
  const mid = `see [anywh-card] here\n\n[anywh-card] {"v":1}\nand more`;
  assert.deepEqual(splitRoomCard(mid), { text: mid });
  const bad = [
    '{"v":1,"kind":"nope"}',
    "not json",
    '{"v":2,"kind":"instruction","title":null}',
    '{"v":1,"kind":"reports","reports":[{"agentId":"a","title":null,"status":"weird","at":1}]}',
  ];
  for (const json of bad) {
    const text = `hi\n\n[anywh-card] ${json}`;
    assert.deepEqual(splitRoomCard(text), { text });
  }
});

test("room card: sits before the relay notes", () => {
  const prompt = withRelayNote(withRoomCard("body", instruction), WITHDRAWN_APPROVAL_NOTE);
  assert.ok(prompt.indexOf("[anywh-card]") < prompt.indexOf("[anywh-note]"));
  assert.deepEqual(splitRoomCard(stripRelayNote(prompt)), { text: "body", card: instruction });
});

test("room card: checks cards strictly", () => {
  assert.equal(isRoomCard(reports), true);
  assert.equal(isRoomCard({ kind: "instruction" }), false);
  assert.equal(isRoomCard(null), false);
});

