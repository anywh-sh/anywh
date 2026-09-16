import { test } from "node:test";
import assert from "node:assert/strict";

import { APPROVE_OPTION_ID, DENY_OPTION_ID, buildApprovalQuestion, isApproved } from "./sharedSession.js";

/**
 * The permission prompt, which no integration test can reach: the real path
 * needs a `claude` child speaking MCP's Streamable HTTP transport mid-turn,
 * and the fake claude fixture doesn't implement it. What it guards is worth
 * the extra seam — `isApproved` is the single comparison standing between a
 * user saying no and a command running on their machine.
 */
test("carries the parts the client needs to ask in its own language", () => {
  const question = buildApprovalQuestion("Bash", { command: "rm -rf build" });
  assert.deepEqual(question.approval, { tool: "Bash", detail: "rm -rf build" });
  // The English sentence stays filled in for a client too old to read
  // `approval` — it is a fallback, not the only copy.
  assert.match(question.question, /Bash/);
  assert.match(question.question, /rm -rf build/);
});

test("gives the plan-mode transition no detail to print", () => {
  const question = buildApprovalQuestion("ExitPlanMode", {});
  assert.deepEqual(question.approval, { tool: "ExitPlanMode", detail: "" });
});

test("offers exactly the two ids the verdict is read from", () => {
  const question = buildApprovalQuestion("Write", { file_path: "/tmp/x" });
  assert.deepEqual(
    question.options.map((option) => option.id),
    [APPROVE_OPTION_ID, DENY_OPTION_ID],
  );
});

test("reads the verdict from the id, not from the label", () => {
  // The whole point of the change: a client that translates its buttons must
  // not be able to change what the relay decides.
  assert.equal(isApproved([{ question: "q", selected: [APPROVE_OPTION_ID] }]), true);
  assert.equal(isApproved([{ question: "q", selected: ["Aprovar"] }]), false);
  assert.equal(isApproved([{ question: "q", selected: ["Approve"] }]), false);
});

test("treats anything that is not an explicit approval as a refusal", () => {
  assert.equal(isApproved([{ question: "q", selected: [DENY_OPTION_ID] }]), false);
  assert.equal(isApproved([{ question: "q", selected: [] }]), false);
  assert.equal(isApproved([]), false);
  assert.equal(isApproved([{ question: "q", selected: ["something the user typed"] }]), false);
});
