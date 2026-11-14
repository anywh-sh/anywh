import { test } from "node:test";
import assert from "node:assert/strict";
import { streamedToolInput } from "./acpDriver.js";

const text = (value: string) => [{ type: "content", content: { type: "text", text: value } }];

test("streamedToolInput: the input once its streamed JSON is whole, and only while the call has not run", () => {
  // The pieces Kimi Code 2.6.0 streams before the permission request.
  assert.equal(streamedToolInput({ toolCallId: "t", status: "in_progress", content: text('{"command":"wc') }), undefined);
  assert.deepEqual(streamedToolInput({ toolCallId: "t", status: "in_progress", content: text('{"command":"wc -c hello.txt"}') }), { command: "wc -c hello.txt" });
  // Once it ran, the content is the call's output, even when it is JSON.
  assert.equal(streamedToolInput({ toolCallId: "t", status: "completed", content: text('{"name":"pkg"}') }), undefined);
  assert.equal(streamedToolInput({ toolCallId: "t", status: "failed", content: text('{"x":1}') }), undefined);
  assert.equal(streamedToolInput({ toolCallId: "t", status: "in_progress", content: text("[1,2]") }), undefined);
  assert.equal(streamedToolInput({ toolCallId: "t", status: "pending", content: text("") }), undefined);
});
