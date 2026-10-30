import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// What the relay answers when no route did: a client reads it cross-origin
// from the app's webview, where a response without CORS headers surfaces as
// a network error instead of a status — so a route an older relay lacks
// (426) or a handler that threw (500) must still carry them, or the
// client's fallback for that relay never gets to run.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

function httpUrl(path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

test("an unknown route answers 426 with CORS, so a client can read it and fall back", async () => {
  const res = await fetch(httpUrl("/control/no-such-route"));
  assert.equal(res.status, 426);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("a handler that throws answers 500 with CORS, and the relay keeps serving", async () => {
  // `%E0` is a malformed escape: decoding the profile id throws inside the
  // PATCH handler, which used to surface as an unhandled rejection.
  const res = await fetch(httpUrl("/control/profiles/%E0"), { method: "PATCH", body: JSON.stringify({ label: "x" }) });
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await res.json(), { error: "internal error" });

  assert.equal((await fetch(httpUrl("/control/profiles"))).status, 200);
});
