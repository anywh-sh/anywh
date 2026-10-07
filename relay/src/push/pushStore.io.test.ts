import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PUSH_DEVICE_TTL_MS } from "./pushDevices.js";
import { PushStore } from "./pushStore.js";

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-push-store-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const input = { gatewayUrl: "https://gw.example.test/n", pushKey: "key-1", label: "iPhone", data: { profileId: "p1" } };

test("registered devices survive a restart, and the file is owner-only", () => {
  withDir((dir) => {
    const file = join(dir, "nested", "push-devices.json");
    const first = new PushStore(file, () => 1000);
    first.put("device-aaa", input);

    const second = new PushStore(file, () => 2000);
    assert.deepEqual(second.all(), [{ deviceId: "device-aaa", ...input, updatedAt: 1000 }]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test("an entry not refreshed within the TTL is gone after a restart, and re-registering refreshes it", () => {
  withDir((dir) => {
    const file = join(dir, "push-devices.json");
    new PushStore(file, () => 0).put("device-aaa", input);

    const later = PUSH_DEVICE_TTL_MS + 1;
    assert.deepEqual(new PushStore(file, () => later).all(), []);

    const store = new PushStore(file, () => PUSH_DEVICE_TTL_MS - 1);
    store.put("device-aaa", input);
    assert.equal(new PushStore(file, () => PUSH_DEVICE_TTL_MS + 5000).all().length, 1);
  });
});

test("expiry is also applied to a long-running store, and the file follows", () => {
  withDir((dir) => {
    const file = join(dir, "push-devices.json");
    let now = 0;
    const store = new PushStore(file, () => now);
    store.put("device-aaa", input);
    now = PUSH_DEVICE_TTL_MS + 1;
    assert.deepEqual(store.all(), []);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
  });
});

test("delete reports whether anything was there; removeByPushKeys drops every holder of a key", () => {
  withDir((dir) => {
    const store = new PushStore(join(dir, "p.json"), () => 1);
    store.put("device-aaa", input);
    store.put("device-bbb", { ...input, pushKey: "key-2" });
    assert.equal(store.delete("device-aaa"), true);
    assert.equal(store.delete("device-aaa"), false);
    store.removeByPushKeys(["key-2"]);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "p.json"), "utf8")), []);
  });
});

test("a missing or corrupt file starts empty instead of stopping the relay", () => {
  withDir((dir) => {
    assert.deepEqual(new PushStore(join(dir, "missing.json")).all(), []);
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json");
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      assert.deepEqual(new PushStore(corrupt).all(), []);
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
  });
});
