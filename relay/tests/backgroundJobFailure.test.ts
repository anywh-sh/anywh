import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): exercises the
// "failed anywh-bg job kept until dismissed" behavior end to end
// (SharedSession.submitBackgroundJobResult/dismissFailedBackgroundJob) —
// only the model's decision to run `anywh-bg` is faked
// (fixtures/fake-claude.mjs's FAKE_CLAUDE_BACKGROUND_JOB), everything
// downstream is real: BackgroundJobTracker polls a real exit file on a real
// (shortened, via BACKGROUND_JOB_POLL_MS) interval, SharedSession keeps the
// failure in its own list, broadcasts it over the real WebSocket, and
// `dismiss_failed_background_job` clears it the same way.

let server: TestServer;

before(async () => {
  // The 10s production poll interval would make this test slow for no
  // reason — same "swap the one knob a test needs" reasoning as
  // AGENT_BIN/SYSTEMCTL_BIN being pointed at fixtures instead of the real
  // thing.
  process.env.BACKGROUND_JOB_POLL_MS = "30";
  server = await startTestServer();
});

after(async () => {
  delete process.env.BACKGROUND_JOB_POLL_MS;
  await server.close();
});

beforeEach(() => {
  delete process.env.FAKE_CLAUDE_REPLY;
  delete process.env.FAKE_CLAUDE_BACKGROUND_JOB;
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_REPLY;
  delete process.env.FAKE_CLAUDE_BACKGROUND_JOB;
});

interface BackgroundJobStateMessage {
  type: "background_job_state";
  jobs: unknown[];
  failedJobs: { id: string; label: string; exitCode: number; pid: number }[];
}

/** Waits for the settled post-failure state specifically (not just "any
 * message with a failed job"): `BackgroundJobTracker.finish` and
 * `SharedSession.submitBackgroundJobResult` each broadcast independently
 * (onFinished, then onChanged), so an earlier `background_job_state` frame
 * can carry the new `failedJobs` entry while the job briefly still lingers
 * in `jobs` too — real but uninteresting ordering, not what this test is
 * about. */
function isFailedJobSettled(message: Record<string, unknown>): boolean {
  if (message.type !== "background_job_state") return false;
  const state = message as unknown as BackgroundJobStateMessage;
  return Array.isArray(state.jobs) && state.jobs.length === 0 && Array.isArray(state.failedJobs) && state.failedJobs.length === 1;
}

test("a background job that exits non-zero stays visible as failed until dismissed", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "anywh-bg-job-"));
  const logPath = join(workDir, "job.log");
  const exitPath = join(workDir, "job.exit");
  writeFileSync(logPath, "");

  const socket = await connectSession(server.port, "session-bg-fail");

  process.env.FAKE_CLAUDE_REPLY = "started it";
  process.env.FAKE_CLAUDE_BACKGROUND_JOB = JSON.stringify({
    anywh_bg: "started",
    id: "job-1",
    pid: 999999,
    log: logPath,
    exitFile: exitPath,
    label: "flaky-migration",
  });
  sendUserMessage(socket, "run the migration in the background");
  await collectUntil(socket, isTurnEnded);

  // The turn that launched it has already ended — the tracker keeps polling
  // on its own. Clear the marker so the follow-up turn `submitBackgroundJobResult`
  // fires below (once the poll notices the exit code) replies normally
  // instead of "starting" the same job again.
  delete process.env.FAKE_CLAUDE_BACKGROUND_JOB;
  process.env.FAKE_CLAUDE_REPLY = "looks like it failed";

  writeFileSync(exitPath, "1\n");

  const messages = await collectUntil(socket, isFailedJobSettled, 5000);
  const state = messages.find(isFailedJobSettled) as unknown as BackgroundJobStateMessage;
  assert.equal(state.failedJobs.length, 1);
  assert.equal(state.failedJobs[0].id, "job-1");
  assert.equal(state.failedJobs[0].label, "flaky-migration");
  assert.equal(state.failedJobs[0].exitCode, 1);

  // `submitBackgroundJobResult` also queues the normal follow-up turn — let
  // it finish so it doesn't bleed into the next test on the same socket.
  await collectUntil(socket, isTurnEnded, 5000);

  socket.send(JSON.stringify({ type: "dismiss_failed_background_job", id: "job-1" }));
  const cleared = await collectUntil(
    socket,
    (message) =>
      message.type === "background_job_state" && (message as unknown as BackgroundJobStateMessage).failedJobs.length === 0,
    5000,
  );
  assert.ok(cleared.length > 0);

  socket.close();
});

test("a running background job's log tail is readable over HTTP until the job ends", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "anywh-bg-job-"));
  const logPath = join(workDir, "job.log");
  const exitPath = join(workDir, "job.exit");
  writeFileSync(logPath, "compiling 1/3\ncompiling 2/3\n");
  const sessionId = "session-bg-log";
  const logUrl = `http://127.0.0.1:${String(server.port)}/background-jobs/log?session=${sessionId}&job=job-log`;

  const socket = await connectSession(server.port, sessionId);

  process.env.FAKE_CLAUDE_REPLY = "started it";
  process.env.FAKE_CLAUDE_BACKGROUND_JOB = JSON.stringify({
    anywh_bg: "started",
    id: "job-log",
    pid: 999999,
    log: logPath,
    exitFile: exitPath,
    label: "build",
  });
  sendUserMessage(socket, "build it in the background");
  await collectUntil(socket, isTurnEnded);
  delete process.env.FAKE_CLAUDE_BACKGROUND_JOB;

  const running = await fetch(logUrl);
  assert.equal(running.status, 200);
  assert.equal(((await running.json()) as { tail: string }).tail, "compiling 1/3\ncompiling 2/3\n");

  const unknown = await fetch(logUrl.replace("job=job-log", "job=nope"));
  assert.equal(unknown.status, 404);

  // Once the job finishes the tracker stops watching it — the tail then
  // lives in `failedJobs` (or nowhere, for a success), not behind this route.
  process.env.FAKE_CLAUDE_REPLY = "done";
  writeFileSync(exitPath, "0\n");
  await collectUntil(
    socket,
    (message) => message.type === "background_job_state" && (message as unknown as BackgroundJobStateMessage).jobs.length === 0,
    5000,
  );
  await collectUntil(socket, isTurnEnded, 5000);
  assert.equal((await fetch(logUrl)).status, 404);

  socket.close();
});
