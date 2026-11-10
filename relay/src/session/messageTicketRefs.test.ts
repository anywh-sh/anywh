import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, MessageTicketRef } from "../protocol/agent-event.js";
import type { BroadcastMessage } from "./broadcast.js";
import { STORED_TICKET_REFS_LIMIT, attachTicketRefs, nextOccurrence, refsInText, restoreStoredTicketRefs, textHasKey, withStoredRefs } from "./messageTicketRefs.js";

const ref = (key: string): MessageTicketRef => ({ provider: "jira", site: "acme.atlassian.net", key });
const said = (text: string): AgentEvent => ({ type: "user_message", text });

test("textHasKey: a whole key only", () => {
  assert.equal(textHasKey("see NGL-12.", "NGL-12"), true);
  assert.equal(textHasKey("NGL-12", "NGL-12"), true);
  assert.equal(textHasKey("NGL-123 and XNGL-12", "NGL-12"), false);
  assert.equal(textHasKey("NGL-123 then NGL-12", "NGL-12"), true);
});

test("refsInText: the refs the text has, once per key", () => {
  assert.deepEqual(refsInText([ref("NGL-1"), ref("NGL-2"), ref("NGL-1")], "do NGL-1 now"), [ref("NGL-1")]);
});

test("nextOccurrence counts the person's messages with the same text only", () => {
  const events: AgentEvent[] = [said("go"), said(" go "), { type: "user_message", text: "go", synthetic: "wakeup" }, said("stop")];
  const history: BroadcastMessage[] = events.map((event) => ({ type: "agent_event", event }));
  assert.equal(nextOccurrence(history, "go"), 2);
  assert.equal(nextOccurrence(history, "other"), 0);
});

test("attachTicketRefs: by text and occurrence, dropping a key the text lost", () => {
  const stored = [
    { text: "ship NGL-7", occurrence: 1, refs: [ref("NGL-7")] },
    { text: "look at NGL-1", occurrence: 0, refs: [ref("NGL-1"), ref("NGL-9")] },
  ];
  const events: AgentEvent[] = [said("ship NGL-7"), { type: "turn_ended", stopped: false }, said("look at NGL-1"), said("ship NGL-7"), { type: "user_message", text: "ship NGL-7", synthetic: "background_job" }];
  const attached = attachTicketRefs(events, stored);
  assert.deepEqual(attached.map((event) => (event.type === "user_message" ? event.ticketRefs : undefined)), [undefined, undefined, [ref("NGL-1")], [ref("NGL-7")], undefined]);
  assert.equal(attachTicketRefs(events, []), events);
});

test("withStoredRefs replaces the same message's entry and keeps the newest ones", () => {
  const once = withStoredRefs([], " go NGL-1 ", 0, [ref("NGL-1")]);
  assert.deepEqual(withStoredRefs(once, "go NGL-1", 0, [ref("NGL-1")]), once);
  let many = once;
  for (let index = 0; index < STORED_TICKET_REFS_LIMIT + 3; index++) many = withStoredRefs(many, `m ${String(index)}`, 0, [ref("NGL-1")]);
  assert.equal(many.length, STORED_TICKET_REFS_LIMIT);
  assert.equal(many.at(-1)?.text, `m ${String(STORED_TICKET_REFS_LIMIT + 2)}`);
});

test("restoreStoredTicketRefs re-checks what the file holds", () => {
  assert.deepEqual(restoreStoredTicketRefs(undefined), []);
  assert.deepEqual(
    restoreStoredTicketRefs([{ text: "a NGL-1", occurrence: 0, refs: [ref("NGL-1"), { key: "bad" }] }, { text: "b", occurrence: -1, refs: [ref("NGL-2")] }, { text: "c", occurrence: 0, refs: [{ key: "bad" }] }, null]),
    [{ text: "a NGL-1", occurrence: 0, refs: [ref("NGL-1")] }],
  );
});
