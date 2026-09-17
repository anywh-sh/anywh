import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApprovalQuestion, buildUserInputQuestions, resolveApprovalAnswer, resolveUserInputAnswers } from "./nativeApproval.js";
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
