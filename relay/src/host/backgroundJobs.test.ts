import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "../protocol/agent-event.js";
import {
  BackgroundJobTracker,
  cancelledMarkerPath,
  isQuietExit,
  extractStartedJobFromEvent,
  parseStartedMarker,
  type FinishedBackgroundJob,
} from "./backgroundJobs.js";

const STARTED_JSON =
  '{"anywh_bg":"started","id":"1788022610814662237-29477","pid":1200509,' +
  '"log":"/home/user/.anywh/bg-jobs/1788022610814662237-29477.log",' +
  '"exitFile":"/home/user/.anywh/bg-jobs/1788022610814662237-29477.exit","label":"sleep-build-stub"}';

// ---- parseStartedMarker -----------------------------------------------

test("parseStartedMarker: recognizes the marker when it is the whole string", () => {
  assert.deepEqual(parseStartedMarker(STARTED_JSON), {
    id: "1788022610814662237-29477",
    pid: 1200509,
    log: "/home/user/.anywh/bg-jobs/1788022610814662237-29477.log",
    exitFile: "/home/user/.anywh/bg-jobs/1788022610814662237-29477.exit",
    label: "sleep-build-stub",
  });
});

test("parseStartedMarker: recognizes the marker with a trailing newline (real printf output)", () => {
  assert.deepEqual(parseStartedMarker(STARTED_JSON + "\n"), {
    id: "1788022610814662237-29477",
    pid: 1200509,
    log: "/home/user/.anywh/bg-jobs/1788022610814662237-29477.log",
    exitFile: "/home/user/.anywh/bg-jobs/1788022610814662237-29477.exit",
    label: "sleep-build-stub",
  });
});

test("parseStartedMarker: text without the marker returns undefined", () => {
  assert.equal(parseStartedMarker("build ok\nexit 0"), undefined);
});

test("parseStartedMarker: JSON that looks similar but with anywh_bg other than \"started\" returns undefined", () => {
  assert.equal(parseStartedMarker('{"anywh_bg":"status","id":"x","done":true}'), undefined);
});

test("parseStartedMarker: missing required field (pid) returns undefined instead of throwing", () => {
  assert.equal(
    parseStartedMarker('{"anywh_bg":"started","id":"x","log":"a","exitFile":"b","label":"c"}'),
    undefined,
  );
});

test("parseStartedMarker: malformed (truncated) JSON returns undefined, doesn't throw", () => {
  assert.equal(parseStartedMarker('{"anywh_bg":"started","id":"x"'), undefined);
});

// ---- extractStartedJobFromEvent ----------------------------------------
//
// `tool_ended.content` is already a flattened plain string by the time it
// reaches here (the mapper that produces it — `claudeStreamJson.test.ts` —
// is what covers the raw `tool_result` shapes, string or array-of-text-
// blocks, that content is flattened from).

function toolResultEvent(content: string): AgentEvent {
  return { type: "tool_ended", toolUseId: "toolu_1", content, isError: false };
}

test("extractStartedJobFromEvent: tool_ended with the marker in its content returns the parsed job", () => {
  const job = extractStartedJobFromEvent(toolResultEvent(STARTED_JSON));
  assert.equal(job?.id, "1788022610814662237-29477");
  assert.equal(job?.label, "sleep-build-stub");
});

test("extractStartedJobFromEvent: a text event (not a tool result) returns undefined", () => {
  const event: AgentEvent = { type: "text", text: STARTED_JSON };
  assert.equal(extractStartedJobFromEvent(event), undefined);
});

test("extractStartedJobFromEvent: tool_ended from another tool (without the marker) returns undefined", () => {
  assert.equal(extractStartedJobFromEvent(toolResultEvent("file.txt created")), undefined);
});

// ---- BackgroundJobTracker -----------------------------------------------

function withJobFiles(run: (dir: string, logPath: string, exitPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bgjobs-test-"));
  try {
    run(dir, join(dir, "job.log"), join(dir, "job.exit"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function startedEvent(id: string, log: string, exitFile: string, label = "test", pid = 12345, alive?: string): AgentEvent {
  return toolResultEvent(
    JSON.stringify({ anywh_bg: "started", id, pid, log, exitFile, label, ...(alive ? { alive } : {}) }),
  );
}

test("BackgroundJobTracker: job still without .exit doesn't fire onFinished and stays in the list", () => {
  withJobFiles((_dir, logPath, exitPath) => {
    writeFileSync(logPath, "running...\n");
    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job) });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath));
    tracker.pollOnce();
    assert.equal(finished.length, 0);
    assert.equal(tracker.listWatched().length, 1);
    tracker.stopPolling();
  });
});

test("BackgroundJobTracker: .exit appearing fires onFinished with exitCode and the log tail, and stops watching", () => {
  withJobFiles((_dir, logPath, exitPath) => {
    writeFileSync(logPath, "build ok\n");
    writeFileSync(exitPath, "0\n");
    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job) });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath, "my-build"));
    tracker.pollOnce();
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.exitCode, 0);
    assert.equal(finished[0]?.logTail, "build ok\n");
    assert.equal(finished[0]?.label, "my-build");
    assert.equal(finished[0]?.sessionId, "sess-1");
    assert.equal(tracker.listWatched().length, 0);
    tracker.stopPolling();
  });
});

test("BackgroundJobTracker: a non-zero exit code is also reported (not treated as a tracker failure)", () => {
  withJobFiles((_dir, logPath, exitPath) => {
    writeFileSync(logPath, "error: file not found\n");
    writeFileSync(exitPath, "1\n");
    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job) });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath));
    tracker.pollOnce();
    assert.equal(finished[0]?.exitCode, 1);
    tracker.stopPolling();
  });
});

test("BackgroundJobTracker: log tail respects logTailBytes (doesn't return the whole file)", () => {
  withJobFiles((_dir, logPath, exitPath) => {
    writeFileSync(logPath, "a".repeat(10_000));
    writeFileSync(exitPath, "0");
    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job), logTailBytes: 100 });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath));
    tracker.pollOnce();
    assert.equal(finished[0]?.logTail.length, 100);
    tracker.stopPolling();
  });
});

test("BackgroundJobTracker: the same id observed twice (duplicate event) doesn't become two watched jobs", () => {
  withJobFiles((_dir, logPath, exitPath) => {
    writeFileSync(logPath, "running...\n");
    const tracker = new BackgroundJobTracker({ onFinished: () => undefined });
    const event = startedEvent("job-1", logPath, exitPath);
    tracker.observeEvent("sess-1", event);
    tracker.observeEvent("sess-1", event);
    assert.equal(tracker.listWatched().length, 1);
    tracker.stopPolling();
  });
});

test("BackgroundJobTracker: a job that exceeds the observation ceiling (maxWatchMs) is dropped without firing onFinished", async () => {
  // Doesn't use `withJobFiles` here: needs to keep the directory alive across
  // a real `setTimeout` (the helper's synchronous cleanup in `finally` would
  // run before the poll, deleting the files too early).
  const dir = mkdtempSync(join(tmpdir(), "anywh-bgjobs-test-"));
  try {
    const logPath = join(dir, "job.log");
    const exitPath = join(dir, "job.exit");
    writeFileSync(logPath, "dev server running forever\n");
    // no .exit — never finishes, exactly the ceiling case

    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job), maxWatchMs: 1 });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath));
    assert.equal(tracker.listWatched().length, 1);

    // real wait to guarantee the 1ms ceiling has already passed before the poll
    // (without this, depending on machine timing, the test would be flaky).
    await new Promise((resolve) => setTimeout(resolve, 20));

    tracker.pollOnce();
    assert.equal(finished.length, 0);
    assert.equal(tracker.listWatched().length, 0);
    tracker.stopPolling();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BackgroundJobTracker: two jobs from the same session are watched/completed independently", () => {
  withJobFiles((dir, _logPath, _exitPath) => {
    const logA = join(dir, "a.log");
    const exitA = join(dir, "a.exit");
    const logB = join(dir, "b.log");
    const exitB = join(dir, "b.exit");
    writeFileSync(logA, "a ok\n");
    writeFileSync(exitA, "0");
    writeFileSync(logB, "b running...\n");

    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job) });
    tracker.observeEvent("sess-1", startedEvent("job-a", logA, exitA, "job-a"));
    tracker.observeEvent("sess-1", startedEvent("job-b", logB, exitB, "job-b"));
    tracker.pollOnce();

    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.label, "job-a");
    assert.equal(tracker.listWatched().length, 1);
    assert.equal(tracker.listWatched()[0]?.label, "job-b");
    tracker.stopPolling();
  });
});

// ---- disk persistence (Phase F) --------------------------------------

test("BackgroundJobTracker: with persistPath, a watched job survives a new tracker (simulates a relay restart)", () => {
  withJobFiles((dir, logPath, exitPath) => {
    writeFileSync(logPath, "running...\n");
    const persistPath = join(dir, "watched.json");

    const trackerA = new BackgroundJobTracker({ onFinished: () => undefined, persistPath });
    trackerA.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath, "survives-restart"));
    assert.equal(trackerA.listWatched().length, 1);
    trackerA.stopPolling();

    // "Relay restart": a NEW tracker, same persistPath — never saw the
    // start event, only what's left on disk.
    const finishedB: FinishedBackgroundJob[] = [];
    const trackerB = new BackgroundJobTracker({ onFinished: (job) => finishedB.push(job), persistPath });
    assert.equal(trackerB.listWatched().length, 1);
    assert.equal(trackerB.listWatched()[0]?.label, "survives-restart");
    assert.equal(trackerB.listWatched()[0]?.pid, 12345);

    // the job had actually already finished while tracker A "was down" —
    // trackerB needs to find this out without waiting for the normal poll.
    writeFileSync(exitPath, "0");
    trackerB.pollOnce();
    assert.equal(finishedB.length, 1);
    assert.equal(trackerB.listWatched().length, 0);
    trackerB.stopPolling();

    // the persistence file also reflects the completion (no ghost job left
    // that a THIRD restart would resurrect again).
    const persisted = JSON.parse(readFileSync(persistPath, "utf8")) as unknown[];
    assert.equal(persisted.length, 0);
  });
});

test("BackgroundJobTracker: without persistPath, behavior stays in-memory-only (no file created)", () => {
  withJobFiles((dir, logPath, exitPath) => {
    writeFileSync(logPath, "running...\n");
    const tracker = new BackgroundJobTracker({ onFinished: () => undefined });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath));
    assert.equal(existsSync(join(dir, "watched.json")), false);
    tracker.stopPolling();
  });
});

test("BackgroundJobTracker: missing or corrupted persistPath starts empty, doesn't throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bgjobs-test-"));
  try {
    const missing = join(dir, "does-not-exist.json");
    const trackerMissing = new BackgroundJobTracker({ onFinished: () => undefined, persistPath: missing });
    assert.equal(trackerMissing.listWatched().length, 0);
    trackerMissing.stopPolling();

    const corrupted = join(dir, "corrupted.json");
    writeFileSync(corrupted, "this is not json{{{");
    const trackerCorrupted = new BackgroundJobTracker({ onFinished: () => undefined, persistPath: corrupted });
    assert.equal(trackerCorrupted.listWatched().length, 0);
    trackerCorrupted.stopPolling();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- cancel (Phase F) ------------------------------------------------------

test("BackgroundJobTracker: cancel really kills the process, removes it from the list and does NOT fire onFinished", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bgjobs-test-"));
  try {
    const logPath = join(dir, "job.log");
    const exitPath = join(dir, "job.exit");
    writeFileSync(logPath, "");

    // `detached: true` makes Node call `setsid()` on the child — same
    // topology as the real `anywh-bg` (the process's PID is already the
    // group's PGID/SID), so `process.kill(-pid, ...)` reaches it the same way.
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const pid = child.pid;
    assert.ok(pid, "spawn should have returned a PID");

    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job) });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath, "cancellable-sleep", pid));
    assert.equal(tracker.listWatched().length, 1);

    const ok = tracker.cancel("sess-1", "job-1");
    assert.equal(ok, true);
    assert.equal(tracker.listWatched().length, 0, "cancel should remove the job from the list immediately, without waiting for the process to die");

    await new Promise((resolve) => setTimeout(resolve, 500));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "the real process should have been killed by cancel");
    assert.equal(finished.length, 0, "cancel should not fire onFinished — whoever cancelled it already knows it was cancelled");

    tracker.stopPolling();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BackgroundJobTracker: cancelling an id that doesn't exist (or already finished) returns false without throwing", () => {
  const tracker = new BackgroundJobTracker({ onFinished: () => undefined });
  assert.equal(tracker.cancel("sess-1", "job-fantasma"), false);
  tracker.stopPolling();
});

// ---- heartbeat / death detection -------------------------------------------

/** Writes the heartbeat file with an mtime `ageMs` in the past — the wrapper
 * touches it every ~5s, so an old mtime is exactly what a wrapper killed
 * from the outside leaves behind. */
function writeHeartbeat(path: string, ageMs: number): void {
  writeFileSync(path, "");
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

/** A PID that is certainly dead: spawns a real process, kills it and waits
 * for the `exit` event (so the OS has already reaped it). */
async function deadPid(): Promise<number> {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid, "spawn should have returned a PID");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGKILL");
  });
  return pid;
}

test("parseStartedMarker: reads the alive (heartbeat) field when the wrapper sends it", () => {
  const parsed = parseStartedMarker(
    '{"anywh_bg":"started","id":"x","pid":7,"log":"/l","exitFile":"/e","alive":"/a","label":"t"}',
  );
  assert.equal(parsed?.alive, "/a");
});

test("parseStartedMarker: marker without alive still parses (older anywh-bg than the relay)", () => {
  const parsed = parseStartedMarker(STARTED_JSON);
  assert.equal(parsed?.alive, undefined);
  assert.equal(parsed?.id, "1788022610814662237-29477");
});

test("BackgroundJobTracker: a live heartbeat keeps the job in the list even with no .exit", () => {
  withJobFiles((dir, logPath, exitPath) => {
    writeFileSync(logPath, "dev server up\n");
    const alivePath = join(dir, "job.alive");
    writeHeartbeat(alivePath, 0);
    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job), heartbeatStaleMs: 30_000 });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath, "dev", 12345, alivePath));
    tracker.pollOnce();
    assert.equal(finished.length, 0);
    assert.equal(tracker.listWatched().length, 1);
    tracker.stopPolling();
  });
});

test("BackgroundJobTracker: stale heartbeat + dead PID reports the job as terminated and stops watching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bgjobs-test-"));
  try {
    const logPath = join(dir, "job.log");
    const exitPath = join(dir, "job.exit");
    const alivePath = join(dir, "job.alive");
    // The real case: `pkill -f "next dev"` matched the wrapper's cmdline too,
    // so no `.exit` was ever written.
    writeFileSync(logPath, "next dev running\n");
    writeHeartbeat(alivePath, 60_000);
    const pid = await deadPid();

    const finished: FinishedBackgroundJob[] = [];
    const changed: string[] = [];
    const tracker = new BackgroundJobTracker({
      onFinished: (job) => finished.push(job),
      onChanged: (sessionId) => changed.push(sessionId),
      heartbeatStaleMs: 30_000,
    });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath, "next dev", pid, alivePath));
    tracker.pollOnce();

    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.terminated, true);
    assert.equal(finished[0]?.exitCode, -1);
    assert.equal(finished[0]?.logTail, "next dev running\n");
    assert.equal(tracker.listWatched().length, 0);
    // start + termination — the UI has to be told the chip is gone.
    assert.deepEqual(changed, ["sess-1", "sess-1"]);
    tracker.stopPolling();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BackgroundJobTracker: stale heartbeat but PID still alive keeps the job (suspended machine, not a dead job)", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bgjobs-test-"));
  try {
    const logPath = join(dir, "job.log");
    const exitPath = join(dir, "job.exit");
    const alivePath = join(dir, "job.alive");
    writeFileSync(logPath, "");
    // Everything frozen by a suspend: hours-old heartbeat, process intact.
    writeHeartbeat(alivePath, 8 * 60 * 60 * 1000);

    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job), heartbeatStaleMs: 30_000 });
    // `process.pid` — a PID that is unquestionably alive.
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath, "long build", process.pid, alivePath));
    tracker.pollOnce();

    assert.equal(finished.length, 0, "a live PID vetoes the stale heartbeat");
    assert.equal(tracker.listWatched().length, 1);
    tracker.stopPolling();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BackgroundJobTracker: heartbeat declared but never created (wrapper died at once) is also detected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bgjobs-test-"));
  try {
    const logPath = join(dir, "job.log");
    const exitPath = join(dir, "job.exit");
    writeFileSync(logPath, "");
    const pid = await deadPid();

    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job), heartbeatStaleMs: 1 });
    // `alive` points at a file that will never exist.
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath, "dead on arrival", pid, join(dir, "job.alive")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    tracker.pollOnce();

    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.terminated, true);
    tracker.stopPolling();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BackgroundJobTracker: a job without a heartbeat (older anywh-bg) keeps the previous behavior", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bgjobs-test-"));
  try {
    const logPath = join(dir, "job.log");
    const exitPath = join(dir, "job.exit");
    writeFileSync(logPath, "");
    const pid = await deadPid();

    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job), heartbeatStaleMs: 1 });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath, "legacy", pid));
    tracker.pollOnce();

    // Dead PID and all, without a heartbeat there's no second signal to
    // confirm it — only `.exit` or the ceiling end this one.
    assert.equal(finished.length, 0);
    assert.equal(tracker.listWatched().length, 1);
    tracker.stopPolling();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BackgroundJobTracker: an .exit that exists but is still empty isn't read as exit -1", () => {
  withJobFiles((dir, logPath, exitPath) => {
    writeFileSync(logPath, "ok\n");
    // Exactly the window `echo $? > file` opens in the old wrapper: the
    // redirect creates the file before the content lands.
    writeFileSync(exitPath, "");
    const alivePath = join(dir, "job.alive");
    writeHeartbeat(alivePath, 0);

    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (job) => finished.push(job), heartbeatStaleMs: 30_000 });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath, "build", 12345, alivePath));
    tracker.pollOnce();
    assert.equal(finished.length, 0, "an empty .exit is 'not ready yet', not a failed job");

    writeFileSync(exitPath, "0\n");
    tracker.pollOnce();
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.exitCode, 0);
    assert.equal(finished[0]?.terminated, undefined);
    tracker.stopPolling();
  });
});

test("BackgroundJobTracker: cancel with a stale heartbeat drops the job WITHOUT signalling the PID (PID reused after a reboot)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bgjobs-test-"));
  try {
    const logPath = join(dir, "job.log");
    const exitPath = join(dir, "job.exit");
    const alivePath = join(dir, "job.alive");
    writeFileSync(logPath, "");
    writeHeartbeat(alivePath, 60_000);

    // Stands in for "the PID in the persisted job now belongs to someone
    // else": a live process that cancel must NOT touch.
    const innocent = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const pid = innocent.pid;
    assert.ok(pid, "spawn should have returned a PID");

    const tracker = new BackgroundJobTracker({ onFinished: () => undefined, heartbeatStaleMs: 30_000 });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath, "ghost", pid, alivePath));
    assert.equal(tracker.cancel("sess-1", "job-1"), true);
    assert.equal(tracker.listWatched().length, 0);

    await new Promise((resolve) => setTimeout(resolve, 500));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, true, "cancel must not signal a PID the heartbeat no longer vouches for");

    innocent.kill("SIGKILL");
    tracker.stopPolling();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- anywh-bg stop ---------------------------------------------------------

const ANYWH_BG = fileURLToPath(new URL("../../scripts/anywh-bg", import.meta.url));

function runBg(home: string, ...args: string[]) {
  return spawnSync("bash", [ANYWH_BG, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });
}

function startRealJob(home: string, cmd: string): { id: string; pid: number; log: string; exitFile: string } {
  const out = runBg(home, "start", "--label", "t", "--cmd", cmd);
  assert.equal(out.status, 0, out.stderr);
  const marker = JSON.parse(out.stdout.trim()) as { id: string; pid: number; log: string; exitFile: string };
  return marker;
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("cancelledMarkerPath: sits next to the .exit file", () => {
  assert.equal(cancelledMarkerPath("/a/b/123-4.exit"), "/a/b/123-4.cancelled");
});

test("anywh-bg stop: a stopped real job fires NO onFinished and the marker is cleaned up", async () => {
  const home = mkdtempSync(join(tmpdir(), "anywh-bgstop-test-"));
  try {
    const job = startRealJob(home, "sleep 30");
    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (j) => finished.push(j) });
    tracker.observeEvent("sess-1", startedEvent(job.id, job.log, job.exitFile, "t", job.pid));

    const stop = runBg(home, "stop", job.id);
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, /"stopped":true/);
    assert.ok(existsSync(cancelledMarkerPath(job.exitFile)), "marker is written");

    await waitFor(() => existsSync(job.exitFile));
    tracker.pollOnce();
    assert.equal(finished.length, 0, "a deliberate stop must not trigger the follow-up turn");
    assert.equal(tracker.listWatched().length, 0);
    assert.equal(existsSync(cancelledMarkerPath(job.exitFile)), false, "marker removed once consumed");
    tracker.stopPolling();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("anywh-bg stop: a job that already finished is NOT silenced", async () => {
  const home = mkdtempSync(join(tmpdir(), "anywh-bgstop-test-"));
  try {
    const job = startRealJob(home, "echo done");
    await waitFor(() => existsSync(job.exitFile));
    const stop = runBg(home, "stop", job.id);
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, /"stopped":false/);
    assert.match(stop.stdout, /already finished/);
    assert.equal(existsSync(cancelledMarkerPath(job.exitFile)), false, "no marker for a finished job");

    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (j) => finished.push(j) });
    tracker.observeEvent("sess-1", startedEvent(job.id, job.log, job.exitFile, "t", job.pid));
    tracker.pollOnce();
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.exitCode, 0);
    tracker.stopPolling();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("anywh-bg stop: unknown id exits 1 with an error", () => {
  const home = mkdtempSync(join(tmpdir(), "anywh-bgstop-test-"));
  try {
    const stop = runBg(home, "stop", "nope");
    assert.equal(stop.status, 1);
    assert.match(stop.stderr, /unknown job/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("BackgroundJobTracker: a cancel marker also silences the wrapper-killed (terminated) path", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bgjobs-test-"));
  try {
    const logPath = join(dir, "job.log");
    const exitPath = join(dir, "job.exit");
    const alivePath = join(dir, "job.alive");
    writeFileSync(logPath, "");
    writeFileSync(alivePath, "");
    utimesSync(alivePath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    writeFileSync(cancelledMarkerPath(exitPath), "");
    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (j) => finished.push(j), heartbeatStaleMs: 1000 });
    // Dead PID: spawn and reap a short process.
    const dead = spawnSync("true");
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath, "t", 2 ** 22 + (dead.pid ?? 0), alivePath));
    tracker.pollOnce();
    assert.equal(finished.length, 0);
    assert.equal(tracker.listWatched().length, 0);
    assert.equal(existsSync(cancelledMarkerPath(exitPath)), false);
    tracker.stopPolling();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isQuietExit: 0/130/143/terminated only", () => {
  for (const exitCode of [0, 130, 143]) assert.equal(isQuietExit({ exitCode }), true);
  assert.equal(isQuietExit({ exitCode: -1, terminated: true }), true);
  for (const exitCode of [1, 2, 124, 137]) assert.equal(isQuietExit({ exitCode }), false);
});

test("BackgroundJobTracker: a cancel marker never swallows a real failure (exit 1), and is still cleaned up", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-bgjobs-test-"));
  try {
    const logPath = join(dir, "job.log");
    const exitPath = join(dir, "job.exit");
    writeFileSync(logPath, "boom");
    writeFileSync(exitPath, "1\n");
    writeFileSync(cancelledMarkerPath(exitPath), "");
    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (j) => finished.push(j) });
    tracker.observeEvent("sess-1", startedEvent("job-1", logPath, exitPath));
    tracker.pollOnce();
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.exitCode, 1);
    assert.equal(existsSync(cancelledMarkerPath(exitPath)), false);
    tracker.stopPolling();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("anywh-bg stop: a job that finishes with exit 1 right after the marker is written is reported, not silenced", () => {
  const home = mkdtempSync(join(tmpdir(), "anywh-bgstop-test-"));
  try {
    const job = startRealJob(home, "sleep 30");
    // `touch` shim: creates the marker like the real one, then makes the job
    // "finish by itself with exit 1" at exactly the racy moment.
    const shimDir = join(home, "shim");
    mkdirSync(shimDir);
    const shim = join(shimDir, "touch");
    writeFileSync(shim, `#!/bin/bash\n/usr/bin/env -i PATH=/usr/bin:/bin touch "$@"\ncase "$1" in *.cancelled) echo 1 > "${job.exitFile}" ;; esac\n`);
    chmodSync(shim, 0o755);
    const out = spawnSync("bash", [ANYWH_BG, "stop", job.id], {
      env: { ...process.env, HOME: home, PATH: `${shimDir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /"stopped":false/);
    assert.match(out.stdout, /already finished \(exit 1\)/);
    assert.equal(existsSync(cancelledMarkerPath(job.exitFile)), false, "marker removed again");

    const finished: FinishedBackgroundJob[] = [];
    const tracker = new BackgroundJobTracker({ onFinished: (j) => finished.push(j) });
    tracker.observeEvent("sess-1", startedEvent(job.id, job.log, job.exitFile, "t", job.pid));
    tracker.pollOnce();
    assert.equal(finished[0]?.exitCode, 1, "the real failure is reported");
    tracker.stopPolling();
    process.kill(-job.pid, "SIGKILL");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
