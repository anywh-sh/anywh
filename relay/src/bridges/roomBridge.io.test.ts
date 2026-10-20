import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomBridge } from "./roomBridge.js";

test("the room key is created private, an existing one opened by others is made private, and a short one replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-room-key-"));
  try {
    const path = join(dir, "p-room.key");
    const first = new RoomBridge(path, "http://127.0.0.1:1/room");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const url = first.urlFor("s1");

    chmodSync(path, 0o644);
    const again = new RoomBridge(path, "http://127.0.0.1:1/room");
    assert.equal(statSync(path).mode & 0o777, 0o600, "tightened before use");
    assert.equal(again.urlFor("s1"), url, "the same key, so the same URLs");

    writeFileSync(path, "short", { mode: 0o600 });
    const replaced = new RoomBridge(path, "http://127.0.0.1:1/room");
    assert.ok(readFileSync(path).length >= 32);
    assert.notEqual(replaced.urlFor("s1"), url);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
