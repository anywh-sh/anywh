import { test } from "node:test";
import assert from "node:assert/strict";
import type { FinishedBackgroundJob } from "../host/backgroundJobs.js";
import { buildBackgroundJobFollowupPrompt } from "./turnMessages.js";

function job(overrides: Partial<FinishedBackgroundJob> = {}): FinishedBackgroundJob {
  return {
    sessionId: "s1",
    id: "job-1",
    label: "npm run build",
    logPath: "/tmp/job-1.log",
    exitPath: "/tmp/job-1.exit",
    startedAt: Date.now(),
    pid: 12345,
    exitCode: 0,
    logTail: "build output",
    ...overrides,
  };
}

test("buildBackgroundJobFollowupPrompt: terminated externally reports no exit code", () => {
  const prompt = buildBackgroundJobFollowupPrompt(job({ terminated: true, exitCode: -1 }));
  assert.match(prompt, /encerrado de fora, sem exit code/);
  assert.doesNotMatch(prompt, /exit -1/);
});

test("buildBackgroundJobFollowupPrompt: exit 0 reports success", () => {
  const prompt = buildBackgroundJobFollowupPrompt(job({ exitCode: 0 }));
  assert.match(prompt, /concluiu com sucesso \(exit 0\)/);
});

test("buildBackgroundJobFollowupPrompt: a nonzero exit reports the code", () => {
  const prompt = buildBackgroundJobFollowupPrompt(job({ exitCode: 2 }));
  assert.match(prompt, /terminou com erro \(exit 2\)/);
});

test("buildBackgroundJobFollowupPrompt: always names the job and includes the log tail", () => {
  const prompt = buildBackgroundJobFollowupPrompt(job({ label: "npm run build", logTail: "compiled ok" }));
  assert.match(prompt, /"npm run build"/);
  assert.match(prompt, /compiled ok/);
});

test("buildBackgroundJobFollowupPrompt: an empty log tail (only whitespace) falls back to a placeholder", () => {
  const prompt = buildBackgroundJobFollowupPrompt(job({ logTail: "   \n  " }));
  assert.match(prompt, /\(sem saída\)/);
});
