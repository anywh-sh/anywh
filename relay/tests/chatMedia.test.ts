import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connectSession } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): `GET /files/media`,
// the route the chat loads inline images and videos from, against a real
// server and real files. `fs/chatMedia.*.test.ts` cover resolution and range
// parsing on their own; this proves the HTTP side a `<video>` depends on
// (206 with Content-Range, 304 on a matching ETag) and that a relative path
// is the session's own cwd, set over the WebSocket.

let server: TestServer;
let base: string;
let workDir: string;
let outsideDir: string;

const PNG_BYTES = Buffer.from("not-really-a-png-but-bytes-are-bytes");
const VIDEO_BYTES = Buffer.alloc(4096, 7);

before(async () => {
  server = await startTestServer();
  base = realpathSync(mkdtempSync(join(tmpdir(), "anywh-chat-media-route-")));
  workDir = join(base, "project");
  outsideDir = join(base, "simulator");
  mkdirSync(join(workDir, "screenshots"), { recursive: true });
  mkdirSync(outsideDir);
  writeFileSync(join(workDir, "screenshots", "home.png"), PNG_BYTES);
  writeFileSync(join(outsideDir, "flow.mp4"), VIDEO_BYTES);
  writeFileSync(join(outsideDir, "notes.txt"), "not media");
});

after(async () => {
  await server.close();
  rmSync(base, { recursive: true, force: true });
});

function mediaUrl(path: string, session = "session-media"): string {
  return `http://127.0.0.1:${server.port}/files/media?session=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}`;
}

async function setCwd(session: string, cwd: string): Promise<void> {
  const socket = await connectSession(server.port, session);
  socket.send(JSON.stringify({ type: "set_cwd", path: cwd }));
  await new Promise<void>((resolveCwd) => {
    function onMessage(raw: Buffer): void {
      const message = JSON.parse(raw.toString()) as { type: string; cwd?: string };
      if (message.type === "cwd_state" && message.cwd === cwd) {
        socket.off("message", onMessage);
        resolveCwd();
      }
    }
    socket.on("message", onMessage);
  });
  socket.close();
}

test("a file outside the session's cwd comes back whole, typed, with the headers a cross-origin fetch needs", async () => {
  const response = await fetch(mediaUrl(join(outsideDir, "flow.mp4")));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("content-length"), String(VIDEO_BYTES.length));
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("access-control-expose-headers") ?? "", /Content-Range/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), VIDEO_BYTES);
});

test("a byte range comes back as 206 with only those bytes, and a range past the end as 416", async () => {
  const partial = await fetch(mediaUrl(join(outsideDir, "flow.mp4")), { headers: { Range: "bytes=100-199" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 100-199/${String(VIDEO_BYTES.length)}`);
  assert.equal(partial.headers.get("content-length"), "100");
  assert.equal((await partial.arrayBuffer()).byteLength, 100);

  const beyond = await fetch(mediaUrl(join(outsideDir, "flow.mp4")), { headers: { Range: `bytes=${String(VIDEO_BYTES.length)}-` } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("content-range"), `bytes */${String(VIDEO_BYTES.length)}`);
});

test("a copy whose ETag still matches gets a 304, and a rewrite of the file a new body", async () => {
  const path = join(outsideDir, "retaken.png");
  writeFileSync(path, "first");
  const first = await fetch(mediaUrl(path));
  const etag = first.headers.get("etag");
  assert.ok(etag);
  await first.arrayBuffer();

  const unchanged = await fetch(mediaUrl(path), { headers: { "If-None-Match": etag } });
  assert.equal(unchanged.status, 304);

  writeFileSync(path, "second, longer");
  const rewritten = await fetch(mediaUrl(path), { headers: { "If-None-Match": etag } });
  assert.equal(rewritten.status, 200);
  assert.equal(await rewritten.text(), "second, longer");
});

test("a relative path and a bare name resolve against the session's own cwd", async () => {
  await setCwd("session-media-cwd", workDir);
  const relative = await fetch(mediaUrl("screenshots/home.png", "session-media-cwd"));
  assert.equal(relative.status, 200);
  assert.deepEqual(Buffer.from(await relative.arrayBuffer()), PNG_BYTES);

  const bare = await fetch(mediaUrl("home.png", "session-media-cwd"));
  assert.equal(bare.status, 200);
  await bare.arrayBuffer();
});

test("a file that isn't media is 415, a missing one 404, and no path at all 400", async () => {
  assert.equal((await fetch(mediaUrl(join(outsideDir, "notes.txt")))).status, 415);
  assert.equal((await fetch(mediaUrl(join(outsideDir, "missing.png")))).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/files/media?session=session-media`)).status, 400);
});
