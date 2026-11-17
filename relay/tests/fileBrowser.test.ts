import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connectSession } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): the work dir file
// panel's HTTP routes (/files/list, /files/read, /files/raw) scoped by a
// real session's cwd, plus the /files WS watch reacting to a REAL
// filesystem write. fsFiles.test.ts already unit-tests the pure
// resolve/list/read logic in isolation — this instead proves the
// session-scoping wiring (server.ts routing by `?session=`) and the real
// `fs.watch` debounce, neither of which a unit test on fsFiles.ts alone can
// reach.

let server: TestServer;
let workDir: string;

before(async () => {
  server = await startTestServer();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "anywh-file-browser-")));
});

after(async () => {
  await server.close();
});

function httpUrl(path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

test("GET /files/list and /files/read are scoped to the session's own cwd, set via set_cwd", async () => {
  const socket = await connectSession(server.port, "session-files");
  socket.send(JSON.stringify({ type: "set_cwd", path: workDir }));
  // set_cwd's only observable ack over the wire is `cwd_state` (broadcast) —
  // waiting for it before touching the HTTP routes is the explicit
  // synchronization the skill's "Determinism" section asks for, instead of
  // assuming the WS message was processed by the time the next HTTP request
  // fires.
  await new Promise<void>((resolveCwd) => {
    function onMessage(raw: Buffer): void {
      const message = JSON.parse(raw.toString()) as { type: string; cwd?: string };
      if (message.type === "cwd_state" && message.cwd === workDir) {
        socket.off("message", onMessage);
        resolveCwd();
      }
    }
    socket.on("message", onMessage);
  });

  const noteContent = "hello from the file browser test\n";
  writeFileSync(join(workDir, "notes.txt"), noteContent);

  const listed = (await (
    await fetch(httpUrl(`/files/list?session=${encodeURIComponent("session-files")}`))
  ).json()) as { root: string; entries: { name: string; kind: string; path: string; size: number }[] };
  assert.equal(listed.root, workDir);
  const notesEntry = listed.entries.find((entry) => entry.name === "notes.txt");
  assert.equal(notesEntry?.kind, "file");
  assert.equal(notesEntry?.path, join(workDir, "notes.txt"));
  assert.equal(notesEntry?.size, Buffer.byteLength(noteContent));

  const read = (await (
    await fetch(httpUrl(`/files/read?session=session-files&path=${encodeURIComponent(join(workDir, "notes.txt"))}`))
  ).json()) as { kind: string; content: string };
  assert.equal(read.kind, "text");
  assert.equal(read.content, noteContent);

  // The download progress bar divides by this header, and a cross-origin
  // fetch only sees it when it's exposed.
  const raw = await fetch(httpUrl(`/files/raw?session=session-files&path=${encodeURIComponent(join(workDir, "notes.txt"))}`));
  assert.equal(raw.headers.get("content-length"), String(Buffer.byteLength(noteContent)));
  assert.match(raw.headers.get("access-control-expose-headers") ?? "", /Content-Length/);
  assert.equal(await raw.text(), noteContent);

  // A path outside the session's cwd is rejected regardless of what the
  // filesystem itself would allow — the actual "root confinement" contract
  // (resolveWithinRoot, fsFiles.ts), exercised here through the real route,
  // not just the pure function.
  const outsideResponse = await fetch(httpUrl(`/files/read?session=session-files&path=${encodeURIComponent(tmpdir())}`));
  assert.equal(outsideResponse.status, 400);

  socket.close();
});

test("POST /files/create is scoped to the session's own cwd", async () => {
  const socket = await connectSession(server.port, "session-files-create");
  socket.send(JSON.stringify({ type: "set_cwd", path: workDir }));
  await new Promise<void>((resolveCwd) => {
    function onMessage(raw: Buffer): void {
      const message = JSON.parse(raw.toString()) as { type: string; cwd?: string };
      if (message.type === "cwd_state" && message.cwd === workDir) {
        socket.off("message", onMessage);
        resolveCwd();
      }
    }
    socket.on("message", onMessage);
  });

  const created = await fetch(httpUrl("/files/create"), {
    method: "POST",
    body: JSON.stringify({ session: "session-files-create", name: "criado.txt" }),
  });
  assert.equal(created.status, 200);
  const createdBody = (await created.json()) as { ok: boolean; path: string };
  assert.equal(createdBody.path, join(workDir, "criado.txt"));

  const listed = (await (await fetch(httpUrl(`/files/list?session=session-files-create`))).json()) as {
    entries: { name: string }[];
  };
  assert.ok(listed.entries.some((entry) => entry.name === "criado.txt"));

  // Same name again is a conflict, not a silent truncation.
  const conflict = await fetch(httpUrl("/files/create"), {
    method: "POST",
    body: JSON.stringify({ session: "session-files-create", name: "criado.txt" }),
  });
  assert.equal(conflict.status, 409);

  socket.close();
});

test("the /files WS watch reports a real filesystem change, debounced", async () => {
  const filesSocket = new WebSocket(`ws://127.0.0.1:${server.port}/files?session=session-files`);
  await new Promise<void>((resolveOpen, reject) => {
    filesSocket.once("open", () => resolveOpen());
    filesSocket.once("error", reject);
  });

  filesSocket.send(JSON.stringify({ type: "watch", dirs: [workDir], files: [] }));

  // Real finding worth guarding against: `update()` reconciles watchers
  // synchronously but `fs.watch` itself needs a moment to actually start
  // observing — writing immediately after `send` risks the write landing
  // before the watcher exists. A short settle avoids a flaky miss without
  // hardcoding how long "a moment" is anywhere else in the test.
  await new Promise((resolveSettle) => setTimeout(resolveSettle, 100));

  const changePromise = new Promise<{ type: string; path: string }>((resolveChange, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for dir_changed")), 5000);
    filesSocket.once("message", (raw: Buffer) => {
      clearTimeout(timeout);
      resolveChange(JSON.parse(raw.toString()) as { type: string; path: string });
    });
  });

  writeFileSync(join(workDir, "new-file.txt"), "triggers a watch notification\n");

  const change = await changePromise;
  assert.equal(change.type, "dir_changed");
  assert.equal(change.path, workDir);

  filesSocket.close();
});
