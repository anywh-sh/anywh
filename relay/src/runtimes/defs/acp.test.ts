import { test } from "node:test";
import assert from "node:assert/strict";
import type { TurnHost, UserInputAnswer } from "../types.js";
import { ACP_CANCELLED_OUTCOME, acpApprovalRequest, acpConfigOptions, acpModelChoices, acpModelOption, answerAcpApproval, answerAcpQuestion, isAcpSessionGoneError } from "./acp.js";

// Shapes recorded from Kimi Code CLI 2.6.0 (`kimi acp`).
const BASH_PERMISSION = {
  sessionId: "s",
  options: [
    { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
    { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
  toolCall: { toolCallId: "0:tool_x", title: "Bash", rawInput: { command: "ls" }, content: [{ type: "content", content: { type: "text", text: "Requesting approval to Running: ls" } }] },
};

function host(overrides: Partial<TurnHost>): TurnHost {
  return {
    requestApproval: () => Promise.reject(new Error("unexpected")),
    requestUserInput: () => Promise.reject(new Error("unexpected")),
    ...overrides,
  };
}

test("an approval offers the decisions the client already translates, and says what it is about", () => {
  const { request, optionFor } = acpApprovalRequest(BASH_PERMISSION);
  assert.deepEqual(
    request.availableDecisions.map((decision) => decision.id),
    ["accept", "acceptForSession", "decline"],
  );
  assert.equal(optionFor.get("acceptForSession"), "approve_always");
  assert.deepEqual(request.detail, { kind: "Bash", text: "ls" });
  assert.equal(request.safeDecisionId, "decline");
});

test("an option of a kind ACP doesn't define keeps its own id and name", () => {
  const { request, optionFor } = acpApprovalRequest({ options: [{ optionId: "custom", name: "Do it differently", kind: "maybe" }] });
  assert.deepEqual(request.availableDecisions, [{ id: "custom", labelKey: "Do it differently" }]);
  assert.equal(optionFor.get("custom"), "custom");
});

test("the human's decision goes back as the agent's own option; a host that gives up answers cancelled", async () => {
  assert.deepEqual(await answerAcpApproval(BASH_PERMISSION, host({ requestApproval: () => Promise.resolve("decline") })), { outcome: { outcome: "selected", optionId: "reject" } });
  assert.deepEqual(await answerAcpApproval(BASH_PERMISSION, host({ requestApproval: () => Promise.reject(new Error("stopped")) })), ACP_CANCELLED_OUTCOME);
  assert.deepEqual(await answerAcpApproval(BASH_PERMISSION, host({ requestApproval: () => Promise.resolve("not-an-option") })), ACP_CANCELLED_OUTCOME);
});

test("a question is answered with the option of the label picked; deferred or unknown dismisses it", async () => {
  const question = {
    question: { id: "q0", header: "Color", question: "Pick one", options: [{ label: "Red" }, { label: "Blue" }] },
    optionForLabel: new Map([
      ["Red", "q0_opt_0"],
      ["Blue", "q0_opt_1"],
    ]),
    dismissOptionId: "q0_skip",
  };
  const answer = (values: string[]): Promise<readonly UserInputAnswer[]> => Promise.resolve([{ questionId: "q0", values }]);
  assert.deepEqual(await answerAcpQuestion(question, host({ requestUserInput: () => answer(["Blue"]) })), { outcome: { outcome: "selected", optionId: "q0_opt_1" } });
  assert.deepEqual(await answerAcpQuestion(question, host({ requestUserInput: () => Promise.resolve("deferred") })), { outcome: { outcome: "selected", optionId: "q0_skip" } });
  assert.deepEqual(await answerAcpQuestion(question, host({ requestUserInput: () => answer(["Green"]) })), { outcome: { outcome: "selected", optionId: "q0_skip" } });
});

test("configOptions: the model picker becomes the catalog, each model with the levels it reports while selected", () => {
  const fresh = acpConfigOptions({
    sessionId: "s",
    configOptions: [
      { type: "select", id: "model", category: "model", currentValue: "kimi-code/k3", options: [{ value: "kimi-code/k3", name: "K3" }, { value: "kimi-code/fast", name: "Fast" }] },
      { type: "select", id: "thinking", category: "thought_level", currentValue: "high", options: [{ value: "low", name: "Thinking Low" }, { value: "high", name: "Thinking High" }] },
    ],
  });
  const { models, defaultId } = acpModelChoices(fresh);
  assert.equal(defaultId, "kimi-code/k3");
  assert.deepEqual(acpModelOption(models[0], fresh), {
    id: "kimi-code/k3",
    label: "K3",
    efforts: [
      { id: "low", description: "Thinking Low" },
      { id: "high", description: "Thinking High" },
    ],
    defaultEffort: "high",
  });
  assert.deepEqual(acpModelOption(models[1], []), { id: "kimi-code/fast", label: "Fast" }, "no level reported, no picker");
  assert.deepEqual(acpConfigOptions({ configOptions: "nope" }), []);
});

test("only an unknown session id means the session is gone", () => {
  assert.equal(isAcpSessionGoneError("Invalid params: Unknown sessionId: session_x"), true);
  assert.equal(isAcpSessionGoneError("Authentication required: Your current subscription does not have access to k"), false);
});
