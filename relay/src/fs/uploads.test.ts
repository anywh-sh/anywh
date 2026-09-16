import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { frameTimestamp, MAX_UPLOAD_BYTES, readRawBody, sanitizeExtension } from "./uploads.js";

// Same fake-EventEmitter pattern mcpBridge.test.ts already uses for
// `IncomingMessage` — `readRawBody` only touches `data`/`end`/`error` and
// (over the limit) `destroy`, no real socket needed.
function fakeRequest(): IncomingMessage & EventEmitter & { destroyed: boolean } {
  const req = new EventEmitter() as IncomingMessage & EventEmitter & { destroyed: boolean };
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  });
  return req;
}

test("readRawBody: concatenates every chunk and resolves on 'end'", async () => {
  const req = fakeRequest();
  const promise = readRawBody(req, 1024);
  queueMicrotask(() => {
    req.emit("data", Buffer.from("hello "));
    req.emit("data", Buffer.from("world"));
    req.emit("end");
  });
  const buffer = await promise;
  assert.equal(buffer.toString("utf8"), "hello world");
});

test("readRawBody: an empty body (immediate 'end', no 'data') resolves to an empty buffer", async () => {
  const req = fakeRequest();
  const promise = readRawBody(req, 1024);
  queueMicrotask(() => req.emit("end"));
  const buffer = await promise;
  assert.equal(buffer.length, 0);
});

test("readRawBody: destroys the connection and rejects once the total exceeds maxBytes", async () => {
  const req = fakeRequest();
  const promise = readRawBody(req, 10);
  queueMicrotask(() => {
    req.emit("data", Buffer.from("this is way more than ten bytes"));
  });
  await assert.rejects(promise, /limite de 0MB/);
  assert.equal(req.destroyed, true);
});

test("readRawBody: propagates a socket error", async () => {
  const req = fakeRequest();
  const promise = readRawBody(req, 1024);
  const boom = new Error("socket hang up");
  queueMicrotask(() => req.emit("error", boom));
  await assert.rejects(promise, boom);
});

test("MAX_UPLOAD_BYTES is exactly 100MB", () => {
  assert.equal(MAX_UPLOAD_BYTES, 100 * 1024 * 1024);
});

test("sanitizeExtension keeps plain alphanumeric extensions as-is", () => {
  assert.equal(sanitizeExtension("png"), "png");
  assert.equal(sanitizeExtension("mp4"), "mp4");
});

test("sanitizeExtension strips anything that isn't ASCII letters/digits (the extension is untrusted, and becomes a path segment)", () => {
  assert.equal(sanitizeExtension("png; rm -rf /"), "pngrmrf");
  assert.equal(sanitizeExtension("../../etc/passwd"), "etcpasswd");
});

test("sanitizeExtension: empty, or entirely special characters, falls back to 'bin'", () => {
  assert.equal(sanitizeExtension(""), "bin");
  assert.equal(sanitizeExtension("..."), "bin");
});

test("frameTimestamp: midpoint of each equal slice, never landing on t=0 or t=duration", () => {
  // 60s video, 6 frames -> slices of 10s, midpoints at 5,15,25,35,45,55.
  const duration = 60;
  const frameCount = 6;
  const timestamps = Array.from({ length: frameCount }, (_, i) => frameTimestamp(duration, i, frameCount));
  assert.deepEqual(timestamps, [5, 15, 25, 35, 45, 55]);
  assert.notEqual(timestamps[0], 0);
  assert.notEqual(timestamps[timestamps.length - 1], duration);
});

test("frameTimestamp: a single frame lands exactly at the midpoint of the whole duration", () => {
  assert.equal(frameTimestamp(10, 0, 1), 5);
});
