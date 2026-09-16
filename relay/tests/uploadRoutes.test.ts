import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// Real integration test (.anywh/skills/tests/SKILL.md): neither `POST
// /upload` (chat attachments, relay/src/fs/uploads.ts) nor `POST
// /files/upload` (the file panel's own upload into a session's working
// directory, fs/fsFiles.ts) was exercised by any integration test before
// this file — real HTTP POST with a real binary body against the real
// route, the real filesystem underneath both.

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

test("POST /upload saves the body under the requested extension and returns its path", async () => {
  const body = Buffer.from("not a real image, just bytes");
  const response = await fetch(httpUrl("/upload?ext=png"), { method: "POST", body });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { path: string; frames?: string[] };
  assert.match(result.path, /\.png$/);
  assert.equal(result.frames, undefined, "a non-video extension never gets frame extraction");
  assert.ok(existsSync(result.path));
  assert.deepEqual(readFileSync(result.path), body);
  rmSync(result.path, { force: true });
});

test("POST /upload sanitizes an extension with path-breaking characters instead of rejecting the request", async () => {
  const response = await fetch(httpUrl("/upload?ext=..%2F..%2Fetc"), { method: "POST", body: Buffer.from("x") });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { path: string };
  // sanitizeExtension strips everything but ASCII letters/digits — no
  // directory traversal survives into the saved filename.
  assert.match(result.path, /\.etc$/);
  rmSync(result.path, { force: true });
});

test("POST /files/upload writes into the session's own cwd, and requires a name", async () => {
  const missingName = await fetch(httpUrl("/files/upload?session=upload-test"), { method: "POST", body: Buffer.from("x") });
  assert.equal(missingName.status, 400);
  const missingNameResult = (await missingName.json()) as { error: string };
  assert.equal(missingNameResult.error, "invalid_path");

  const body = Buffer.from("uploaded file panel content");
  const created = await fetch(httpUrl("/files/upload?session=upload-test&name=note.txt"), { method: "POST", body });
  assert.equal(created.status, 200);
  const createdResult = (await created.json()) as { ok: boolean; path: string };
  assert.equal(createdResult.ok, true);
  assert.match(createdResult.path, /note\.txt$/);
  assert.deepEqual(readFileSync(createdResult.path), body);

  // Same name again, same session: fs/fsFiles.ts's createFile refuses to
  // clobber an existing file, and the route surfaces that as a real error
  // status via statusForFilesError, not a silent 200.
  const conflict = await fetch(httpUrl("/files/upload?session=upload-test&name=note.txt"), { method: "POST", body: Buffer.from("y") });
  assert.equal(conflict.status, 409);
  const conflictResult = (await conflict.json()) as { error: string };
  assert.equal(conflictResult.error, "already_exists");
});
