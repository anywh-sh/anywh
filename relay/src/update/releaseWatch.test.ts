import { test } from "node:test";
import assert from "node:assert/strict";
import { needsRestart, supervisedForRestart, watchForNewRelease, type ReleaseWatchOptions } from "./releaseWatch.js";

/** A watch whose timer never fires within a test: every check is explicit. */
function watch(options: Omit<ReleaseWatchOptions, "intervalMs" | "log">) {
  const lines: string[] = [];
  const handle = watchForNewRelease({ ...options, intervalMs: 3_600_000, log: (line) => lines.push(line) });
  return { handle, lines };
}

test("only a different real release on disk calls for a restart", () => {
  assert.equal(needsRestart("0.2.40", "0.2.41"), true);
  // A rollback put on disk by hand is picked up too: the disk is the truth.
  assert.equal(needsRestart("0.2.41", "0.2.40"), true);
  assert.equal(needsRestart("0.2.41", "0.2.41"), false);
  assert.equal(needsRestart("0.2.41", null), false);
  assert.equal(needsRestart("0.0.0", "0.0.0"), false);
  assert.equal(needsRestart("0.2.41", "0.0.0"), false);
});

test("a busy process defers the restart and takes it on the first check where it is idle", async () => {
  let busy = true;
  const restarts: string[] = [];
  const { handle, lines } = watch({ running: "0.2.40", readOnDisk: () => "0.2.41", safeToRestart: () => !busy, restart: (v) => restarts.push(v) });
  try {
    assert.equal(await handle.check(), false);
    assert.equal(await handle.check(), false);
    assert.deepEqual(restarts, []);
    assert.equal(lines.filter((line) => line.includes("deferred")).length, 1, "the deferral is logged once, not on every tick");
    busy = false;
    assert.equal(await handle.check(), true);
    assert.deepEqual(restarts, ["0.2.41"]);
    // Never twice, even if asked again while shutting down.
    assert.equal(await handle.check(), false);
    assert.deepEqual(restarts, ["0.2.41"]);
  } finally {
    handle.stop();
  }
});

test("nothing on disk to pick up never asks whether it is safe", async () => {
  let asked = 0;
  const { handle } = watch({
    running: "0.2.40",
    readOnDisk: () => "0.2.40",
    safeToRestart: () => {
      asked++;
      return true;
    },
    restart: () => assert.fail("must not restart"),
  });
  try {
    assert.equal(await handle.check(), false);
    assert.equal(asked, 0);
  } finally {
    handle.stop();
  }
});

test("an async safety check runs one at a time: a check while one is pending does nothing", async () => {
  let release: (value: boolean) => void = () => undefined;
  const restarts: string[] = [];
  const { handle } = watch({
    running: "0.2.40",
    readOnDisk: () => "0.2.41",
    safeToRestart: () => new Promise<boolean>((resolve) => (release = resolve)),
    restart: (v) => restarts.push(v),
  });
  try {
    const first = handle.check();
    assert.equal(await handle.check(), false);
    release(true);
    assert.equal(await first, true);
    assert.deepEqual(restarts, ["0.2.41"]);
  } finally {
    handle.stop();
  }
});

test("restarting is only allowed under a service manager that starts the process again", () => {
  assert.equal(supervisedForRestart({ INVOCATION_ID: "abc" }), true);
  assert.equal(supervisedForRestart({}), false);
  assert.equal(supervisedForRestart({ INVOCATION_ID: "" }), false);
  assert.equal(supervisedForRestart({ ANYWH_RESTART_ON_UPDATE: "0", INVOCATION_ID: "abc" }), false);
  assert.equal(supervisedForRestart({ ANYWH_RESTART_ON_UPDATE: "1" }), true);
});
