import { test } from "node:test";
import assert from "node:assert/strict";
import { createFrameDecoder, createJsonRpcConnection, encodeFrame, JsonRpcRemoteError } from "./jsonRpcStdio.js";

// ---- encodeFrame ------------------------------------------------------------

test("encodeFrame: ndjson appends a single trailing newline", () => {
  assert.equal(encodeFrame("ndjson", '{"a":1}'), '{"a":1}\n');
});

test("encodeFrame: lsp-headers prefixes a byte-accurate Content-Length header", () => {
  const payload = '{"a":"héllo"}'; // multi-byte char, so byte length != string length
  const frame = encodeFrame("lsp-headers", payload);
  assert.equal(frame, `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
});

// ---- createFrameDecoder: ndjson ---------------------------------------------

test("ndjson decoder: one push, one frame", () => {
  const decoder = createFrameDecoder("ndjson");
  assert.deepEqual(decoder.push('{"a":1}\n'), ['{"a":1}']);
});

test("ndjson decoder: a frame split across two chunks is held until complete", () => {
  const decoder = createFrameDecoder("ndjson");
  assert.deepEqual(decoder.push('{"a":'), []);
  assert.deepEqual(decoder.push('1}\n'), ['{"a":1}']);
});

test("ndjson decoder: two frames in one chunk both come out, in order", () => {
  const decoder = createFrameDecoder("ndjson");
  assert.deepEqual(decoder.push('{"a":1}\n{"a":2}\n'), ['{"a":1}', '{"a":2}']);
});

test("ndjson decoder: blank lines between frames are skipped", () => {
  const decoder = createFrameDecoder("ndjson");
  assert.deepEqual(decoder.push('{"a":1}\n\n{"a":2}\n'), ['{"a":1}', '{"a":2}']);
});

test("ndjson decoder: tolerates \\r\\n line endings", () => {
  const decoder = createFrameDecoder("ndjson");
  assert.deepEqual(decoder.push('{"a":1}\r\n'), ['{"a":1}']);
});

// ---- createFrameDecoder: lsp-headers -----------------------------------------

test("lsp-headers decoder: one push, one frame", () => {
  const decoder = createFrameDecoder("lsp-headers");
  const payload = '{"a":1}';
  assert.deepEqual(decoder.push(`Content-Length: ${payload.length}\r\n\r\n${payload}`), [payload]);
});

test("lsp-headers decoder: header and body arriving in separate chunks", () => {
  const decoder = createFrameDecoder("lsp-headers");
  const payload = '{"a":1}';
  assert.deepEqual(decoder.push(`Content-Length: ${payload.length}\r\n\r\n`), []);
  assert.deepEqual(decoder.push(payload), [payload]);
});

test("lsp-headers decoder: body split mid-way across chunks", () => {
  const decoder = createFrameDecoder("lsp-headers");
  const payload = '{"a":1}';
  assert.deepEqual(decoder.push(`Content-Length: ${payload.length}\r\n\r\n${payload.slice(0, 3)}`), []);
  assert.deepEqual(decoder.push(payload.slice(3)), [payload]);
});

test("lsp-headers decoder: two frames back to back in one chunk", () => {
  const decoder = createFrameDecoder("lsp-headers");
  const a = '{"a":1}';
  const b = '{"b":2}';
  const chunk = `Content-Length: ${a.length}\r\n\r\n${a}Content-Length: ${b.length}\r\n\r\n${b}`;
  assert.deepEqual(decoder.push(chunk), [a, b]);
});

test("lsp-headers decoder: extra headers before Content-Length don't confuse it", () => {
  const decoder = createFrameDecoder("lsp-headers");
  const payload = '{"a":1}';
  const chunk = `Content-Type: application/vscode-jsonrpc\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`;
  assert.deepEqual(decoder.push(chunk), [payload]);
});

test("lsp-headers decoder: a header block with no Content-Length is dropped, not looped on forever", () => {
  const decoder = createFrameDecoder("lsp-headers");
  const payload = '{"a":1}';
  const chunk = `X-Bogus: yes\r\n\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`;
  assert.deepEqual(decoder.push(chunk), [payload]);
});

// ---- createJsonRpcConnection: outbound requests ------------------------------

function fakeWriter() {
  const written: string[] = [];
  return { written, write: (chunk: string) => written.push(chunk) };
}

test("request: sends a framed request with an id, resolves on a matching success response", async () => {
  const { written, write } = fakeWriter();
  const conn = createJsonRpcConnection({ framing: "ndjson", write, onNotification: () => {}, onRequest: () => undefined });

  const resultPromise = conn.request("thread/start", { cwd: "/tmp" });
  assert.equal(written.length, 1);
  const sent = JSON.parse(written[0]) as { jsonrpc: string; id: number; method: string; params: unknown };
  assert.equal(sent.jsonrpc, "2.0");
  assert.equal(sent.method, "thread/start");
  assert.deepEqual(sent.params, { cwd: "/tmp" });
  assert.equal(conn.pendingCount, 1);

  conn.receive(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { threadId: "t1" } }) + "\n");
  assert.deepEqual(await resultPromise, { threadId: "t1" });
  assert.equal(conn.pendingCount, 0);
});

test("request: rejects with a JsonRpcRemoteError on a matching error response", async () => {
  const { write } = fakeWriter();
  let capturedId = 0;
  const patchedWrite = (chunk: string) => {
    capturedId = (JSON.parse(chunk) as { id: number }).id;
    write(chunk);
  };
  const conn = createJsonRpcConnection({ framing: "ndjson", write: patchedWrite, onNotification: () => {}, onRequest: () => undefined });

  const resultPromise = conn.request("turn/start", {});
  conn.receive(JSON.stringify({ jsonrpc: "2.0", id: capturedId, error: { code: -32000, message: "boom" } }) + "\n");

  await assert.rejects(resultPromise, (error: unknown) => {
    assert.ok(error instanceof JsonRpcRemoteError);
    assert.equal(error.code, -32000);
    assert.equal(error.message, "boom");
    return true;
  });
  assert.equal(conn.pendingCount, 0);
});

test("request: two concurrent requests correlate correctly even answered out of order", async () => {
  const { written, write } = fakeWriter();
  const conn = createJsonRpcConnection({ framing: "ndjson", write, onNotification: () => {}, onRequest: () => undefined });

  const first = conn.request("a", {});
  const second = conn.request("b", {});
  const [firstId, secondId] = written.map((line) => (JSON.parse(line) as { id: number }).id);

  // Answer the second request first — correlation must key off `id`, not order.
  conn.receive(JSON.stringify({ jsonrpc: "2.0", id: secondId, result: "second" }) + "\n");
  conn.receive(JSON.stringify({ jsonrpc: "2.0", id: firstId, result: "first" }) + "\n");

  assert.equal(await first, "first");
  assert.equal(await second, "second");
});

test("notify: sends without an id, never registers as pending", () => {
  const { written, write } = fakeWriter();
  const conn = createJsonRpcConnection({ framing: "ndjson", write, onNotification: () => {}, onRequest: () => undefined });
  conn.notify("session/ping", undefined);
  const sent = JSON.parse(written[0]) as Record<string, unknown>;
  assert.equal("id" in sent, false);
  assert.equal(conn.pendingCount, 0);
});

test("an unmatched response (unknown id) is ignored rather than throwing", () => {
  const conn = createJsonRpcConnection({ framing: "ndjson", write: () => {}, onNotification: () => {}, onRequest: () => undefined });
  assert.doesNotThrow(() => conn.receive(JSON.stringify({ jsonrpc: "2.0", id: 999, result: "?" }) + "\n"));
});

test("a malformed frame (invalid JSON) is dropped rather than throwing", () => {
  const conn = createJsonRpcConnection({ framing: "ndjson", write: () => {}, onNotification: () => {}, onRequest: () => undefined });
  assert.doesNotThrow(() => conn.receive("not json at all\n"));
});

// ---- createJsonRpcConnection: inbound (server -> client) requests -----------

test("inbound request: onRequest's resolved value is sent back as a success response", async () => {
  const { written, write } = fakeWriter();
  const conn = createJsonRpcConnection({
    framing: "ndjson",
    write,
    onNotification: () => {},
    onRequest: (method) => (method === "item/tool/requestUserInput" ? Promise.resolve({ text: "yes" }) : undefined),
  });

  conn.receive(JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "item/tool/requestUserInput", params: { prompt: "?" } }) + "\n");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(written.length, 1);
  assert.deepEqual(JSON.parse(written[0]), { jsonrpc: "2.0", id: "srv-1", result: { text: "yes" } });
});

test("inbound request: onRequest's rejection is sent back as an error response", async () => {
  const { written, write } = fakeWriter();
  const conn = createJsonRpcConnection({
    framing: "ndjson",
    write,
    onNotification: () => {},
    onRequest: () => Promise.reject(new Error("no host attached")),
  });

  conn.receive(JSON.stringify({ jsonrpc: "2.0", id: "srv-2", method: "item/commandExecution/requestApproval", params: {} }) + "\n");
  await new Promise((resolve) => setImmediate(resolve));

  const response = JSON.parse(written[0]) as { error: { message: string } };
  assert.equal(response.error.message, "no host attached");
});

test("inbound request: onRequest returning undefined sends method-not-found instead of hanging the daemon", () => {
  const { written, write } = fakeWriter();
  const conn = createJsonRpcConnection({ framing: "ndjson", write, onNotification: () => {}, onRequest: () => undefined });

  conn.receive(JSON.stringify({ jsonrpc: "2.0", id: "srv-3", method: "unknown/method", params: {} }) + "\n");

  const response = JSON.parse(written[0]) as { error: { code: number } };
  assert.equal(response.error.code, -32601);
});

test("inbound notification: dispatched to onNotification, never to onRequest", () => {
  const notifications: { method: string; params: unknown }[] = [];
  const conn = createJsonRpcConnection({
    framing: "ndjson",
    write: () => {},
    onNotification: (method, params) => notifications.push({ method, params }),
    onRequest: () => {
      throw new Error("onRequest must not be called for a notification");
    },
  });

  conn.receive(JSON.stringify({ jsonrpc: "2.0", method: "item/started", params: { id: "1" } }) + "\n");
  assert.deepEqual(notifications, [{ method: "item/started", params: { id: "1" } }]);
});
