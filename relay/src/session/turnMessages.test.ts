import { test } from "node:test";
import assert from "node:assert/strict";
import type { FinishedBackgroundJob } from "../host/backgroundJobs.js";
import { buildBackgroundJobFollowupPrompt, buildDeferredApprovalFollowup, isNoReply, NO_REPLY, offersSilence } from "./turnMessages.js";

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

test("offersSilence: only exit 0 / 130 / 143 / terminated may be silent", () => {
  for (const exitCode of [0, 130, 143]) assert.equal(offersSilence(job({ exitCode })), true, `exit ${String(exitCode)}`);
  assert.equal(offersSilence(job({ exitCode: -1, terminated: true })), true);
});

test("offersSilence: real failures (1, 2, 65, 124, 137, -1 without terminated) never qualify", () => {
  for (const exitCode of [1, 2, 65, 124, 126, 127, 137, -1]) {
    assert.equal(offersSilence(job({ exitCode })), false, `exit ${String(exitCode)}`);
  }
});

test("buildBackgroundJobFollowupPrompt: NO_REPLY is mentioned only when silence is offered", () => {
  for (const exitCode of [0, 130, 143]) {
    assert.match(buildBackgroundJobFollowupPrompt(job({ exitCode })), new RegExp(NO_REPLY));
  }
  assert.match(buildBackgroundJobFollowupPrompt(job({ exitCode: -1, terminated: true })), new RegExp(NO_REPLY));
  for (const exitCode of [1, 2, 65, 124]) {
    assert.doesNotMatch(buildBackgroundJobFollowupPrompt(job({ exitCode })), new RegExp(NO_REPLY), `exit ${String(exitCode)}`);
  }
});

test("buildBackgroundJobFollowupPrompt: the failure variant keeps the original report-only instruction", () => {
  const prompt = buildBackgroundJobFollowupPrompt(job({ exitCode: 1 }));
  assert.match(prompt, /Resuma o resultado pro usuário, de forma concisa\. Isto é só um relatório automático/);
});

test("isNoReply: tolerates whitespace, backticks and a trailing period, nothing more", () => {
  for (const ok of ["NO_REPLY", "  NO_REPLY\n", "`NO_REPLY`", "NO_REPLY.", '"NO_REPLY"']) assert.equal(isNoReply(ok), true, ok);
  for (const no of ["", "no_reply", "NO_REPLY, o servidor caiu", "Resultado: NO_REPLY", "NO_REPLY NO_REPLY"]) {
    assert.equal(isNoReply(no), false, no);
  }
});

test("buildDeferredApprovalFollowup: an approval says so first and names every approved call to repeat", () => {
  const text = buildDeferredApprovalFollowup([
    { tool: "Write", detail: "/tmp/out.txt", approved: true },
    { tool: "Bash", detail: "git status", approved: true, agentId: "sub-1" },
  ]);
  assert.match(text, /^approved: retry the denied call/);
  assert.match(text, /- Write \/tmp\/out\.txt\n/);
  assert.match(text, /- Bash git status \(from subagent sub-1\)/);
  assert.doesNotMatch(text, /do not retry/i);
});

test("buildDeferredApprovalFollowup: a refusal alone tells the model not to retry", () => {
  const text = buildDeferredApprovalFollowup([{ tool: "Bash", detail: "rm -rf build", approved: false }]);
  assert.match(text, /^denied by the user/);
  assert.match(text, /do not retry/i);
  assert.match(text, /- Bash rm -rf build/);
  assert.doesNotMatch(text, /^approved/);
});

test("buildDeferredApprovalFollowup: a mix lists both groups, approvals first", () => {
  const text = buildDeferredApprovalFollowup([
    { tool: "Write", detail: "/a", approved: false },
    { tool: "Write", detail: "/b", approved: true },
  ]);
  assert.match(text, /^approved: retry the denied call/);
  assert.ok(text.indexOf("- Write /b") < text.indexOf("- Write /a"));
  assert.match(text, /denied by the user.*do not retry/is);
});

test("buildDeferredApprovalFollowup: ExitPlanMode reads as leaving plan mode, with no detail to print", () => {
  const text = buildDeferredApprovalFollowup([{ tool: "ExitPlanMode", detail: "", approved: true }]);
  assert.match(text, /- ExitPlanMode\n?$/);
  assert.match(text, /plan/i);
});

test("buildDeferredApprovalFollowup: an approved call that could not be pre-authorised says it will be asked again", () => {
  const text = buildDeferredApprovalFollowup([
    { tool: "Bash", detail: "ls | head", approved: true, granted: false },
    { tool: "Bash", detail: "rm -rf ~/x", approved: false },
  ]);
  assert.match(text, /^approved: /);
  assert.match(text, /no permission could be pre-authorised/);
  assert.match(text, /asked again/i);
  assert.match(text, /- Bash ls \| head/);
  assert.match(text, /denied by the user: do not retry.*- Bash rm -rf ~\/x/s);
  assert.doesNotMatch(text, /retry the denied call/, "it is not cleared to run without asking");
});
