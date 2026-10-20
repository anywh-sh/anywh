import { test } from "node:test";
import assert from "node:assert/strict";
import { promptOffersSilence, ROOM_DIGEST_PREFIX } from "../protocol/silentEvents.js";
import { buildRoomDigest, isUrgent, type DigestEntry } from "./roomDigest.js";

const entry = (over: Partial<DigestEntry> = {}): DigestEntry => ({ agentId: "a1", title: "Count lines", status: "done", summary: "42 lines", artifacts: [], fromRelay: false, ...over });

test("only a failure or a block is urgent", () => {
  assert.deepEqual((["done", "failed", "blocked"] as const).map(isUrgent), [false, true, true]);
});

test("a digest lists every report, offers silence, and is recognised as an offer on replay", () => {
  const text = buildRoomDigest([entry(), entry({ agentId: "a2", title: null, summary: "line one\nline two", artifacts: ["out.md", "b.md"] })], { stillWorking: 0 });
  assert.ok(text.startsWith(ROOM_DIGEST_PREFIX));
  assert.match(text, /2 agents you started have reported/);
  assert.match(text, /1\. "Count lines" \(agentId a1\): done\n {3}42 lines/);
  assert.match(text, /2\. "\(untitled\)" \(agentId a2\): done\n {3}line one\n {3}line two\n {3}Artifacts: out\.md, b\.md/);
  assert.ok(promptOffersSilence(text));
  assert.doesNotMatch(text, /failed or is blocked/);
});

test("an urgent digest says so, counts what is still going on, and flags reports written by the relay", () => {
  const text = buildRoomDigest([entry({ status: "failed", fromRelay: true, summary: "The agent's turn failed: x" })], { stillWorking: 2, awaitingPerson: 1 });
  assert.match(text, /An agent you started has reported/);
  assert.match(text, /noted by the relay, not by the agent/);
  assert.match(text, /2 more agents are still working/);
  assert.match(text, /1 more agent is waiting for the person/);
  assert.match(text, /failed or is blocked/);
});

test("titles are cut to one bounded line", () => {
  const text = buildRoomDigest([entry({ title: `a\nb ${"x".repeat(200)}` })], { stillWorking: 0 });
  const line = text.split("\n").find((l) => l.startsWith("1. "))!;
  assert.ok(line.includes('"a b xxx') && line.includes("…"));
});
