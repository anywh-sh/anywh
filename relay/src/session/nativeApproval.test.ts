import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvingDecisionIds,
  buildApprovalQuestion,
  buildUserInputQuestions,
  deferredNativeCall,
  nativeCallDigest,
  planNativeVerdicts,
  resolveApprovalAnswer,
  resolveUserInputAnswers,
} from "./nativeApproval.js";
import type { ApprovalRequest, UserInputQuestion } from "../runtimes/types.js";

function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    summary: "Codex wants to run: rm -rf build",
    availableDecisions: [
      { id: "accept", labelKey: "codex.decision.accept" },
      { id: "decline", labelKey: "codex.decision.decline" },
    ],
    ...overrides,
  };
}

test("buildApprovalQuestion: resolves each decision's labelKey to display text, carries the question text as-is", () => {
  const question = buildApprovalQuestion(approvalRequest());
  assert.equal(question.question, "Codex wants to run: rm -rf build");
  assert.deepEqual(question.options, [
    { id: "accept", label: "Accept" },
    { id: "decline", label: "Decline" },
  ]);
});

test("buildApprovalQuestion: carries detail/reason into the two-audience `approval` field, absent when the request has none", () => {
  const withDetail = buildApprovalQuestion(approvalRequest({ detail: { kind: "command", text: "rm -rf build", reason: "cleanup" } }));
  assert.deepEqual(withDetail.approval, { tool: "command", detail: "rm -rf build", reason: "cleanup" });

  const withoutDetail = buildApprovalQuestion(approvalRequest());
  assert.equal(withoutDetail.approval, undefined);
});

test("resolveApprovalAnswer: a real selection wins over the safe default", () => {
  assert.equal(resolveApprovalAnswer([{ question: "q", selected: ["accept"] }], "decline"), "accept");
});

test("resolveApprovalAnswer: no answer at all (forced resolve) falls back to the def's declared safe id", () => {
  assert.equal(resolveApprovalAnswer([], "decline"), "decline");
});

test("resolveApprovalAnswer: no answer and no safe id falls back to an empty string, same as before this contract existed", () => {
  assert.equal(resolveApprovalAnswer([], undefined), "");
});

function userInputQuestion(overrides: Partial<UserInputQuestion> = {}): UserInputQuestion {
  return { id: "q1", question: "Which environment?", ...overrides };
}

test("buildUserInputQuestions: a question with real options becomes a real multiple-choice ChoiceQuestion", () => {
  const [wire] = buildUserInputQuestions([userInputQuestion({ options: [{ label: "staging", description: "the staging env" }] })]);
  assert.deepEqual(wire.options, [{ label: "staging", description: "the staging env" }]);
});

test("buildUserInputQuestions: no options translates to an empty options array, never undefined", () => {
  const [wire] = buildUserInputQuestions([userInputQuestion()]);
  assert.deepEqual(wire.options, []);
});

test("buildUserInputQuestions: isSecret carries through as `secret`, absent (not false) when not set", () => {
  const [secret] = buildUserInputQuestions([userInputQuestion({ secret: true })]);
  assert.equal(secret.secret, true);
  const [notSecret] = buildUserInputQuestions([userInputQuestion()]);
  assert.equal(notSecret.secret, undefined);
});

test("resolveUserInputAnswers: correlates each answer to its question by array position", () => {
  const questions = [userInputQuestion({ id: "q1" }), userInputQuestion({ id: "q2", question: "Which region?" })];
  const answers = [
    { question: "Which environment?", selected: ["staging"] },
    { question: "Which region?", selected: ["us-east"] },
  ];
  assert.deepEqual(resolveUserInputAnswers(questions, answers), [
    { questionId: "q1", values: ["staging"] },
    { questionId: "q2", values: ["us-east"] },
  ]);
});

test("resolveUserInputAnswers: a question with no matching answer (forced resolve) gets an empty values array, not dropped", () => {
  const questions = [userInputQuestion({ id: "q1" }), userInputQuestion({ id: "q2" })];
  assert.deepEqual(resolveUserInputAnswers(questions, []), [
    { questionId: "q1", values: [] },
    { questionId: "q2", values: [] },
  ]);
});

// A Kimi Bash approval as the ACP engine builds it (decision ids from
// `DECISION_BY_KIND`), marked deferrable with the call's real input.
function kimiBashRequest(command: string | undefined): ApprovalRequest {
  return {
    id: "0:tool_bash",
    summary: `Requesting approval to Running: ${command ?? "…"}`,
    detail: { kind: "Bash", text: command ?? "cd /a && wc…" },
    availableDecisions: [
      { id: "accept", labelKey: "acp.decision.allowOnce" },
      { id: "acceptForSession", labelKey: "acp.decision.allowAlways" },
      { id: "decline", labelKey: "acp.decision.rejectOnce" },
    ],
    safeDecisionId: "decline",
    deferrable: command === undefined ? {} : { call: { tool: "Bash", input: { command } } },
  };
}

test("nativeCallDigest: the same call however its keys are ordered, a different one past where the stored copy is cut", () => {
  assert.equal(nativeCallDigest({ tool: "Write", input: { path: "/a", content: "x" } }), nativeCallDigest({ tool: "Write", input: { content: "x", path: "/a" } }));
  assert.notEqual(nativeCallDigest({ tool: "Bash", input: { command: "ls" } }), nativeCallDigest({ tool: "Write", input: { command: "ls" } }));
  // The stored input is shortened past 4096 characters; the digest is not.
  const long = "x".repeat(5000);
  assert.notEqual(nativeCallDigest({ tool: "Write", input: { path: "/a", content: `${long}1` } }), nativeCallDigest({ tool: "Write", input: { path: "/a", content: `${long}2` } }));
});

test("approvingDecisionIds: every decision but the refusals", () => {
  assert.deepEqual(approvingDecisionIds(kimiBashRequest("ls")), ["accept", "acceptForSession"]);
  assert.deepEqual(
    approvingDecisionIds({ ...kimiBashRequest("ls"), availableDecisions: [{ id: "accept", labelKey: "" }, { id: "rejectAlways", labelKey: "" }, { id: "decline", labelKey: "" }] }),
    ["accept"],
  );
});

test("deferredNativeCall: kept with what approves it and the digest of its whole input; without a known input, nothing a repeat could match", () => {
  const call = deferredNativeCall(kimiBashRequest("ls"));
  assert.deepEqual(call, {
    tool: "Bash",
    input: { command: "ls" },
    toolUseId: "0:tool_bash",
    native: { approveIds: ["accept", "acceptForSession"], digest: nativeCallDigest({ tool: "Bash", input: { command: "ls" } }) },
  });
  const unknown = deferredNativeCall(kimiBashRequest(undefined));
  assert.equal(unknown.native?.digest, undefined);
  assert.deepEqual(unknown.input, { detail: "cd /a && wc…" });
});

test("planNativeVerdicts: approved calls are let through with the decision picked; refused ones and approved ones nothing can recognise are not", () => {
  const requests = [kimiBashRequest("ls"), kimiBashRequest("rm -rf build"), kimiBashRequest(undefined)];
  const calls = requests.map(deferredNativeCall);
  const questions = requests.map(buildApprovalQuestion);
  const { decisions, grants } = planNativeVerdicts(calls, questions, [
    { question: "", selected: ["acceptForSession"] },
    { question: "", selected: ["decline"] },
    { question: "", selected: ["accept"] },
  ]);
  assert.deepEqual(grants, [{ digest: calls[0].native?.digest, decisionId: "acceptForSession" }]);
  assert.deepEqual(decisions, [
    { tool: "Bash", detail: "ls", approved: true, granted: true },
    { tool: "Bash", detail: "rm -rf build", approved: false, granted: false },
    { tool: "Bash", detail: "cd /a && wc…", approved: true, granted: false },
  ]);
  // No answer at all is not a yes.
  assert.deepEqual(planNativeVerdicts(calls.slice(0, 1), questions.slice(0, 1), []).grants, []);
});
