import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, connectSessionAndCollectUntil, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md) for the NO_REPLY
// escape on automatic background-job reports. Only the model is faked
// (fixtures/fake-claude.mjs): the job tracker polls a real exit file, the
// relay holds/flushes/suppresses the report turn and talks to a real
// WebSocket client.

let server: TestServer;

before(async () => {
  process.env.BACKGROUND_JOB_POLL_MS = "30";
  server = await startTestServer();
});
after(async () => {
  delete process.env.BACKGROUND_JOB_POLL_MS;
  await server.close();
});
function clearEnv(): void {
  delete process.env.FAKE_CLAUDE_REPLY;
  delete process.env.FAKE_CLAUDE_BACKGROUND_JOB;
}
beforeEach(clearEnv);
afterEach(clearEnv);

interface FailedJobsState {
  type: "background_job_state";
  jobs: unknown[];
  failedJobs: { id: string; exitCode: number }[];
}

/** Starts a (fake) background job from a first turn and returns the paths
 * the test uses to finish it. */
async function startJob(socket: WebSocket, id: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-silent-bg-"));
  const logPath = join(dir, "job.log");
  const exitPath = join(dir, "job.exit");
  writeFileSync(logPath, "");
  process.env.FAKE_CLAUDE_REPLY = "started it";
  process.env.FAKE_CLAUDE_BACKGROUND_JOB = JSON.stringify({
    anywh_bg: "started",
    id,
    pid: 999999,
    log: logPath,
    exitFile: exitPath,
    label: `job ${id}`,
  });
  sendUserMessage(socket, "run it in the background");
  await collectUntil(socket, isTurnEnded);
  delete process.env.FAKE_CLAUDE_BACKGROUND_JOB;
  return exitPath;
}

/** Resolves once the report turn that follows a finished job is over: the
 * relay's `turn_state` goes active and back to idle. Works whether or not
 * the turn's events were shown. */
async function untilReportTurnOver(socket: WebSocket): Promise<Record<string, unknown>[]> {
  let sawActive = false;
  return collectUntil(
    socket,
    (message) => {
      if (message.type === "turn_state" && message.active === true) sawActive = true;
      return sawActive && message.type === "turn_state" && message.active === false;
    },
    8000,
  );
}

function agentEvents(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.filter((m) => m.type === "agent_event").map((m) => m.event as Record<string, unknown>);
}

function lastJobState(messages: Record<string, unknown>[]): FailedJobsState | undefined {
  return messages.filter((m) => m.type === "background_job_state").at(-1) as unknown as FailedJobsState | undefined;
}

test("exit 143 answered NO_REPLY: nothing reaches the client, nothing in the failure tray, not in a later replay", async () => {
  const socket = await connectSession(server.port, "session-silent-143");
  const exitPath = await startJob(socket, "job-143");

  process.env.FAKE_CLAUDE_REPLY = "NO_REPLY";
  writeFileSync(exitPath, "143\n");
  const messages = await untilReportTurnOver(socket);

  const events = agentEvents(messages);
  assert.deepEqual(events, [], "a silenced report must not stream any agent event");
  assert.equal(lastJobState(messages)?.failedJobs.length ?? 0, 0, "and must leave no failed-job entry");
  socket.close();

  // A device connecting later must not see the synthetic note either, while
  // the real first turn is still there.
  const { messages: replay } = await connectSessionAndCollectUntil(server.port, "session-silent-143", (m) => m.type === "caught_up");
  const page = replay.find((m) => m.type === "history_page") as unknown as { messages: { event: Record<string, unknown> }[] };
  assert.ok(page.messages.some((m) => m.event.type === "user_message" && m.event.text === "run it in the background"));
  assert.ok(!page.messages.some((m) => m.event.type === "user_message" && m.event.synthetic === "background_job"));
  assert.ok(!page.messages.some((m) => m.event.type === "text" && m.event.text === "NO_REPLY"));
});

test("exit 143 with a real summary is shown, in order, and lands in the failure tray after the turn", async () => {
  const socket = await connectSession(server.port, "session-silent-143-text");
  const exitPath = await startJob(socket, "job-143t");

  process.env.FAKE_CLAUDE_REPLY = "The server died with an OOM kill.";
  writeFileSync(exitPath, "143\n");
  const messages = await untilReportTurnOver(socket);

  const types = agentEvents(messages).map((e) => e.type);
  assert.deepEqual(types.filter((t) => ["turn_started", "user_message", "text", "turn_ended"].includes(t as string)), ["turn_started", "user_message", "text", "turn_ended"]);
  const state = lastJobState(messages);
  assert.equal(state?.failedJobs.length, 1);
  assert.equal(state?.failedJobs[0]?.exitCode, 143);
  socket.close();
});

test("exit 1: a NO_REPLY answer is NEVER suppressed and the failure is recorded", async () => {
  const socket = await connectSession(server.port, "session-silent-exit1");
  const exitPath = await startJob(socket, "job-exit1");

  process.env.FAKE_CLAUDE_REPLY = "NO_REPLY";
  writeFileSync(exitPath, "1\n");
  const messages = await untilReportTurnOver(socket);

  const events = agentEvents(messages);
  assert.ok(events.some((e) => e.type === "user_message" && e.synthetic === "background_job"));
  assert.ok(events.some((e) => e.type === "text" && e.text === "NO_REPLY"), "the model's text is shown as-is");
  assert.equal(lastJobState(messages)?.failedJobs[0]?.exitCode, 1);
  socket.close();
});

test("exit 0 with NO_REPLY plus extra text is shown", async () => {
  const socket = await connectSession(server.port, "session-silent-extra");
  const exitPath = await startJob(socket, "job-extra");

  process.env.FAKE_CLAUDE_REPLY = "NO_REPLY, but the migration printed warnings";
  writeFileSync(exitPath, "0\n");
  const messages = await untilReportTurnOver(socket);

  assert.ok(agentEvents(messages).some((e) => e.type === "text" && String(e.text).startsWith("NO_REPLY, but")));
  socket.close();
});

test("a turn that calls a tool is never silenced, even when its text is NO_REPLY; the held events flush in order", async () => {
  const socket = await connectSession(server.port, "session-silent-tool");
  const exitPath = await startJob(socket, "job-tool");

  // The report turn itself starts another job (a tool call), then says NO_REPLY.
  const dir = mkdtempSync(join(tmpdir(), "anywh-silent-bg-"));
  process.env.FAKE_CLAUDE_REPLY = "NO_REPLY";
  process.env.FAKE_CLAUDE_BACKGROUND_JOB = JSON.stringify({
    anywh_bg: "started",
    id: "job-tool-2",
    pid: 999999,
    log: join(dir, "j.log"),
    exitFile: join(dir, "j.exit"),
    label: "second",
  });
  writeFileSync(join(dir, "j.log"), "");
  writeFileSync(exitPath, "0\n");
  const messages = await untilReportTurnOver(socket);

  const types = agentEvents(messages).map((e) => e.type as string);
  const iStarted = types.indexOf("turn_started");
  const iUser = types.indexOf("user_message");
  const iTool = types.indexOf("tool_started");
  const iEnd = types.indexOf("turn_ended");
  assert.ok(iStarted >= 0 && iStarted < iUser && iUser < iTool && iTool < iEnd, `order was ${types.join(",")}`);
  socket.close();
});
