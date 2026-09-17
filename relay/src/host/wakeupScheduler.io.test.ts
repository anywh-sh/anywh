import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../protocol/agent-event.js";
import { WakeupScheduler } from "./wakeupScheduler.js";

function toolStarted(toolUseId: string, input: Record<string, unknown>): AgentEvent {
  return { type: "tool_started", toolUseId, name: "ScheduleWakeup", kind: "other", input };
}

function toolEnded(toolUseId: string, isError = false): AgentEvent {
  return { type: "tool_ended", toolUseId, content: "", isError };
}

function withTmpDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-wakeups-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- observeEvent / firing ----------------------------------------------

test("WakeupScheduler: a valid ScheduleWakeup call arms and fires onFire after the real delay", async () => {
  const fired: { sessionId: string; prompt: string }[] = [];
  const scheduler = new WakeupScheduler({ onFire: (sessionId, prompt) => fired.push({ sessionId, prompt }) });
  scheduler.observeEvent("sess-1", toolStarted("t1", { delaySeconds: 0.05, prompt: "keep going" }));
  scheduler.observeEvent("sess-1", toolEnded("t1"));
  assert.equal(scheduler.listArmed().length, 1);

  await wait(200);
  assert.deepEqual(fired, [{ sessionId: "sess-1", prompt: "keep going" }]);
  assert.equal(scheduler.listArmed().length, 0);
});

test("WakeupScheduler: a failed call (tool_ended.isError) doesn't arm anything", () => {
  const fired: unknown[] = [];
  const scheduler = new WakeupScheduler({ onFire: () => fired.push(1) });
  scheduler.observeEvent("sess-1", toolStarted("t1", { delaySeconds: 60, prompt: "keep going" }));
  scheduler.observeEvent("sess-1", toolEnded("t1", true));
  assert.equal(scheduler.listArmed().length, 0);
});

test("WakeupScheduler: a tool_started with no matching tool_ended before the turn ends is simply never armed", () => {
  const scheduler = new WakeupScheduler({ onFire: () => undefined });
  scheduler.observeEvent("sess-1", toolStarted("t1", { delaySeconds: 60, prompt: "keep going" }));
  assert.equal(scheduler.listArmed().length, 0);
});

test("WakeupScheduler: a tool_started for a different tool name is ignored", () => {
  const scheduler = new WakeupScheduler({ onFire: () => undefined });
  scheduler.observeEvent("sess-1", { type: "tool_started", toolUseId: "t1", name: "Bash", kind: "shell", input: { delaySeconds: 60, prompt: "x" } });
  scheduler.observeEvent("sess-1", toolEnded("t1"));
  assert.equal(scheduler.listArmed().length, 0);
});

test("WakeupScheduler: a second call in the same session replaces the first — only the most recent stays armed", async () => {
  const fired: string[] = [];
  const scheduler = new WakeupScheduler({ onFire: (_sessionId, prompt) => fired.push(prompt) });
  scheduler.observeEvent("sess-1", toolStarted("t1", { delaySeconds: 60, prompt: "first" }));
  scheduler.observeEvent("sess-1", toolEnded("t1"));
  scheduler.observeEvent("sess-1", toolStarted("t2", { delaySeconds: 0.05, prompt: "second" }));
  scheduler.observeEvent("sess-1", toolEnded("t2"));
  assert.equal(scheduler.listArmed().length, 1);
  assert.equal(scheduler.listArmed()[0]?.prompt, "second");

  await wait(200);
  assert.deepEqual(fired, ["second"]);
});

test("WakeupScheduler: stop: true cancels an armed wakeup before it fires", async () => {
  const fired: unknown[] = [];
  const scheduler = new WakeupScheduler({ onFire: () => fired.push(1) });
  scheduler.observeEvent("sess-1", toolStarted("t1", { delaySeconds: 0.05, prompt: "keep going" }));
  scheduler.observeEvent("sess-1", toolEnded("t1"));
  scheduler.observeEvent("sess-1", toolStarted("t2", { stop: true }));
  scheduler.observeEvent("sess-1", toolEnded("t2"));
  assert.equal(scheduler.listArmed().length, 0);

  await wait(200);
  assert.equal(fired.length, 0);
});

test("WakeupScheduler: cancelForSession on a session with nothing armed returns false without throwing", () => {
  const scheduler = new WakeupScheduler({ onFire: () => undefined });
  assert.equal(scheduler.cancelForSession("sess-ghost"), false);
});

test("WakeupScheduler: cancelForSession drops a still-pending call too, so a late tool_ended can't resurrect a wakeup", () => {
  const fired: unknown[] = [];
  const scheduler = new WakeupScheduler({ onFire: () => fired.push(1) });
  scheduler.observeEvent("sess-1", toolStarted("t1", { delaySeconds: 60, prompt: "keep going" }));
  scheduler.cancelForSession("sess-1");
  scheduler.observeEvent("sess-1", toolEnded("t1"));
  assert.equal(scheduler.listArmed().length, 0);
  assert.equal(fired.length, 0);
});

test("WakeupScheduler: two sessions with independent wakeups don't interfere", async () => {
  const fired: { sessionId: string; prompt: string }[] = [];
  const scheduler = new WakeupScheduler({ onFire: (sessionId, prompt) => fired.push({ sessionId, prompt }) });
  scheduler.observeEvent("sess-a", toolStarted("t1", { delaySeconds: 0.05, prompt: "a" }));
  scheduler.observeEvent("sess-a", toolEnded("t1"));
  scheduler.observeEvent("sess-b", toolStarted("t2", { delaySeconds: 0.05, prompt: "b" }));
  scheduler.observeEvent("sess-b", toolEnded("t2"));
  assert.equal(scheduler.listArmed().length, 2);

  await wait(200);
  assert.equal(fired.length, 2);
  assert.ok(fired.some((f) => f.sessionId === "sess-a" && f.prompt === "a"));
  assert.ok(fired.some((f) => f.sessionId === "sess-b" && f.prompt === "b"));
});

// ---- disk persistence ----------------------------------------------------

test("WakeupScheduler: with persistPath, an armed wakeup survives a new scheduler instance (simulates a relay restart)", () => {
  withTmpDir((dir) => {
    const persistPath = join(dir, "wakeups.json");
    const schedulerA = new WakeupScheduler({ onFire: () => undefined, persistPath });
    schedulerA.observeEvent("sess-1", toolStarted("t1", { delaySeconds: 3600, prompt: "resume later" }));
    schedulerA.observeEvent("sess-1", toolEnded("t1"));
    assert.equal(schedulerA.listArmed().length, 1);

    // "Relay restart": a NEW scheduler, same persistPath — never saw the
    // tool_started/tool_ended, only what's left on disk.
    const firedB: string[] = [];
    const schedulerB = new WakeupScheduler({ onFire: (_sessionId, prompt) => firedB.push(prompt), persistPath });
    assert.equal(schedulerB.listArmed().length, 1);
    assert.equal(schedulerB.listArmed()[0]?.prompt, "resume later");
    assert.equal(schedulerB.listArmed()[0]?.sessionId, "sess-1");
  });
});

test("WakeupScheduler: a wakeup whose fireAt already passed fires immediately on load (relay was down past it)", async () => {
  // Not `withTmpDir`: that helper's cleanup is synchronous and would delete
  // the directory before this test's `await wait(...)` below ever resolves.
  const dir = mkdtempSync(join(tmpdir(), "anywh-wakeups-test-"));
  try {
    const persistPath = join(dir, "wakeups.json");
    writeFileSync(persistPath, JSON.stringify([{ sessionId: "sess-1", fireAt: Date.now() - 60_000, prompt: "overdue" }]));

    const fired: string[] = [];
    const scheduler = new WakeupScheduler({ onFire: (_sessionId, prompt) => fired.push(prompt), persistPath });
    void scheduler;
    await wait(100);
    assert.deepEqual(fired, ["overdue"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WakeupScheduler: cancelling and re-arming after a restart persists correctly (no ghost entry left behind)", () => {
  withTmpDir((dir) => {
    const persistPath = join(dir, "wakeups.json");
    const schedulerA = new WakeupScheduler({ onFire: () => undefined, persistPath });
    schedulerA.observeEvent("sess-1", toolStarted("t1", { delaySeconds: 3600, prompt: "first" }));
    schedulerA.observeEvent("sess-1", toolEnded("t1"));
    assert.equal(schedulerA.cancelForSession("sess-1"), true);

    const schedulerB = new WakeupScheduler({ onFire: () => undefined, persistPath });
    assert.equal(schedulerB.listArmed().length, 0);
  });
});

test("WakeupScheduler: missing or corrupted persistPath starts empty, doesn't throw", () => {
  withTmpDir((dir) => {
    const missing = join(dir, "does-not-exist.json");
    const schedulerMissing = new WakeupScheduler({ onFire: () => undefined, persistPath: missing });
    assert.equal(schedulerMissing.listArmed().length, 0);

    const corrupted = join(dir, "corrupted.json");
    writeFileSync(corrupted, "this is not json{{{");
    const schedulerCorrupted = new WakeupScheduler({ onFire: () => undefined, persistPath: corrupted });
    assert.equal(schedulerCorrupted.listArmed().length, 0);
  });
});
