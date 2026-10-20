import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidAgentId, parseClientMessage, parseHostMessage } from "./protocol.js";

test("parseClientMessage accepts the four ops with their required fields", () => {
  assert.deepEqual(parseClientMessage('{"op":"hello","version":1,"client":"relay","release":"0.1.8"}'), {
    ok: true,
    message: { op: "hello", version: 1, client: "relay", release: "0.1.8" },
  });
  assert.deepEqual(parseClientMessage('{"op":"subscribe","id":3,"agentId":"a-1","fromOffset":120,"incarnation":"abc"}'), {
    ok: true,
    message: { op: "subscribe", id: 3, agentId: "a-1", fromOffset: 120, incarnation: "abc" },
  });
  assert.deepEqual(parseClientMessage('{"op":"unsubscribe","id":4,"agentId":"a-1"}'), { ok: true, message: { op: "unsubscribe", id: 4, agentId: "a-1" } });
  assert.deepEqual(parseClientMessage('{"op":"request","id":5,"method":"activity"}'), { ok: true, message: { op: "request", id: 5, method: "activity", params: {} } });
});

test("parseClientMessage rejects malformed input instead of guessing", () => {
  const cases: [string, string][] = [
    ["not json", "bad_json"],
    ["[1,2]", "not_an_object"],
    ['{"op":"hello"}', "bad_hello"],
    ['{"op":"subscribe","id":1,"agentId":"../etc","fromOffset":0}', "bad_subscribe"],
    ['{"op":"subscribe","id":1,"agentId":"a","fromOffset":-1}', "bad_subscribe"],
    ['{"op":"subscribe","id":1,"agentId":"a","fromOffset":1.5}', "bad_subscribe"],
    ['{"op":"request","id":"x","method":"activity"}', "bad_request"],
    ['{"op":"teleport"}', "unknown_op"],
  ];
  for (const [line, error] of cases) {
    const parsed = parseClientMessage(line);
    assert.equal(parsed.ok, false, line);
    if (!parsed.ok) assert.equal(parsed.error, error, line);
  }
  // A request with an id but no method is answered, not left to time out.
  assert.deepEqual(parseClientMessage('{"op":"request","id":4}'), { ok: false, error: "bad_request", id: 4 });
  // The id survives a rejection, so the error can be answered.
  assert.deepEqual(parseClientMessage('{"op":"subscribe","id":9,"agentId":"../x","fromOffset":0}'), { ok: false, error: "bad_subscribe", id: 9 });
});

test("agent ids are limited to what is safe in a file name and an environment value", () => {
  assert.equal(isValidAgentId("worker_1-a"), true);
  assert.equal(isValidAgentId(""), false);
  assert.equal(isValidAgentId("-leading-dash"), false);
  assert.equal(isValidAgentId("a/b"), false);
  assert.equal(isValidAgentId("a".repeat(129)), false);
  // Reserved for the host's own processes (the shared Codex app-server).
  assert.equal(isValidAgentId("codex-app-server"), false);
});

test("parseHostMessage reports an unknown message type instead of passing it on", () => {
  assert.equal(parseHostMessage('{"type":"event","agentId":"a","seq":0,"off":0,"next":10,"t":1,"ev":{}}').ok, true);
  assert.deepEqual(parseHostMessage('{"type":"surprise"}'), { ok: false, error: "unknown_type" });
  assert.deepEqual(parseHostMessage("{"), { ok: false, error: "bad_json" });
});
