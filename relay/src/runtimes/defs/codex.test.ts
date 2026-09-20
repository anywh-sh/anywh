import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCoherent } from "../registry.js";
import { codexRuntimeDef } from "./codex.js";
import type { TurnContext } from "../types.js";

function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return { cwd: "/tmp/project", prompt: "hi", permissionModeId: "workspace-write", ...overrides };
}

test("codexRuntimeDef is coherent", () => {
  assert.deepEqual(assertCoherent(codexRuntimeDef), []);
});

test("exec.thread.start: builds a minimal ThreadStartParams (cwd only — everything else is optional)", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  assert.deepEqual(codexRuntimeDef.exec.thread.start(turnContext()), { method: "thread/start", params: { cwd: "/tmp/project" } });
});

test("exec.turn.start: threadId comes from the engine, not TurnContext; prompt becomes a UserInput text block", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const spec = codexRuntimeDef.exec.turn.start(turnContext({ prompt: "list the files", permissionModeId: "read-only" }), "thread-123");
  assert.deepEqual(spec, {
    method: "turn/start",
    params: {
      threadId: "thread-123",
      input: [{ type: "text", text: "list the files", text_elements: [] }],
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
  });
});

// ---- turn/start's actual application of the session's chosen mode --------

test("exec.turn.start: every real mode id maps to real approvalPolicy/sandboxPolicy wire params", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const start = codexRuntimeDef.exec.turn.start;

  const readOnly = start(turnContext({ permissionModeId: "read-only" }), "t1");
  assert.deepEqual((readOnly.params as { approvalPolicy: unknown }).approvalPolicy, "on-request");
  assert.deepEqual((readOnly.params as { sandboxPolicy: unknown }).sandboxPolicy, { type: "readOnly", networkAccess: false });

  // `granular.sandbox_approval: true`, not the legacy `on-failure` — that
  // value doesn't exist in the real wire AskForApproval union (module doc
  // comment) and was never actually exercised before turn/start applied the
  // mode at all.
  const workspaceWrite = start(turnContext({ cwd: "/tmp/project", permissionModeId: "workspace-write" }), "t1");
  assert.deepEqual((workspaceWrite.params as { approvalPolicy: unknown }).approvalPolicy, {
    granular: { sandbox_approval: true, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: false },
  });
  assert.deepEqual((workspaceWrite.params as { sandboxPolicy: unknown }).sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["/tmp/project"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });

  const fullAccess = start(turnContext({ permissionModeId: "full-access" }), "t1");
  assert.deepEqual((fullAccess.params as { approvalPolicy: unknown }).approvalPolicy, "never");
  assert.deepEqual((fullAccess.params as { sandboxPolicy: unknown }).sandboxPolicy, { type: "dangerFullAccess" });
});

test("exec.turn.start: an id this def doesn't recognize sends no approvalPolicy/sandboxPolicy override at all", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const spec = codexRuntimeDef.exec.turn.start(turnContext({ permissionModeId: "not_a_real_mode" }), "t1");
  assert.deepEqual(spec.params, { threadId: "t1", input: [{ type: "text", text: "hi", text_elements: [] }] });
});

test("exec.turn.start: never sends a `permissions` field — real binary rejects it alongside sandboxPolicy", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  for (const mode of ["read-only", "workspace-write", "full-access"]) {
    const spec = codexRuntimeDef.exec.turn.start(turnContext({ permissionModeId: mode }), "t1");
    assert.ok(!("permissions" in (spec.params as object)), `${mode} must not carry a "permissions" field`);
  }
});

test("exec.turn.interrupt: builds turn/interrupt with both ids as params, not just a method name", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  assert.deepEqual(codexRuntimeDef.exec.turn.interrupt("thread-123", "turn-456"), {
    method: "turn/interrupt",
    params: { threadId: "thread-123", turnId: "turn-456" },
  });
});

test("exec.mapNotification: delegates to mapCodexNotification (real item mapping, not a stub)", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const events = codexRuntimeDef.exec.mapNotification("item/completed", { item: { type: "agentMessage", id: "i1", text: "hi there" } }, { turnId: "t1" });
  assert.deepEqual(events, [{ type: "text", text: "hi there" }]);
});

test("permissions.modesFor: workspace-write is absent on win32, present everywhere else; the default survives on both", () => {
  const linuxModes = codexRuntimeDef.permissions.modesFor("linux").map((mode) => mode.id);
  assert.deepEqual(linuxModes, ["read-only", "workspace-write", "full-access"]);
  const win32Modes = codexRuntimeDef.permissions.modesFor("win32").map((mode) => mode.id);
  assert.deepEqual(win32Modes, ["read-only", "full-access"]);
});

// ---- handleServerRequest: item/commandExecution/requestApproval ----------

test("handleServerRequest (command approval): a real command builds a readable summary and passes availableDecisions through", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: (request: unknown) => {
      captured = request;
      return Promise.resolve("accept");
    },
    requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
  };
  const result = await codexRuntimeDef.exec.handleServerRequest(
    "item/commandExecution/requestApproval",
    { kind: "command", command: "rm -rf build", reason: "cleanup", availableDecisions: ["accept", "decline"] },
    host,
  );
  assert.deepEqual(captured, {
    id: (captured as { id: string }).id,
    summary: "Codex wants to run: rm -rf build (cleanup)",
    detail: { kind: "command", text: "rm -rf build", reason: "cleanup" },
    availableDecisions: [
      { id: "accept", labelKey: "codex.decision.accept" },
      { id: "decline", labelKey: "codex.decision.decline" },
    ],
    safeDecisionId: "decline",
  });
  assert.deepEqual(result, { decision: "accept" });
});

test("handleServerRequest (command approval): a null availableDecisions falls back to the base four-decision set", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: (request: unknown) => {
      captured = request;
      return Promise.resolve("cancel");
    },
    requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
  };
  await codexRuntimeDef.exec.handleServerRequest("item/commandExecution/requestApproval", { command: "ls" }, host);
  assert.deepEqual((captured as { availableDecisions: { id: string }[] }).availableDecisions.map((d) => d.id), [
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
  ]);
  assert.equal((captured as { safeDecisionId: string }).safeDecisionId, "cancel");
});

test("handleServerRequest (command approval): the two amendment-carrying decision variants are filtered out, not guessed at", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: (request: unknown) => {
      captured = request;
      return Promise.resolve("accept");
    },
    requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
  };
  await codexRuntimeDef.exec.handleServerRequest(
    "item/commandExecution/requestApproval",
    { command: "curl example.com", availableDecisions: ["accept", { applyNetworkPolicyAmendment: {} }, "decline"] },
    host,
  );
  assert.deepEqual((captured as { availableDecisions: { id: string }[] }).availableDecisions.map((d) => d.id), ["accept", "decline"]);
});

test("handleServerRequest (command approval): no command text and no commandActions falls back to a readable placeholder", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: (request: unknown) => {
      captured = request;
      return Promise.resolve("decline");
    },
    requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
  };
  await codexRuntimeDef.exec.handleServerRequest("item/commandExecution/requestApproval", {}, host);
  assert.equal((captured as { summary: string }).summary, "Codex wants to run: (no command text)");
});

// ---- handleServerRequest: item/fileChange/requestApproval -----------------

test("handleServerRequest (file-change approval): always offers the fixed base decisions, safe default is cancel", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: (request: unknown) => {
      captured = request;
      return Promise.resolve("accept");
    },
    requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
  };
  const result = await codexRuntimeDef.exec.handleServerRequest(
    "item/fileChange/requestApproval",
    { reason: "extra write access", grantRoot: "/tmp/project/build" },
    host,
  );
  assert.deepEqual(captured, {
    id: (captured as { id: string }).id,
    summary: "Codex wants to change files under /tmp/project/build (extra write access)",
    detail: { kind: "fileChange", text: "/tmp/project/build", reason: "extra write access" },
    availableDecisions: [
      { id: "accept", labelKey: "codex.decision.accept" },
      { id: "acceptForSession", labelKey: "codex.decision.acceptForSession" },
      { id: "decline", labelKey: "codex.decision.decline" },
      { id: "cancel", labelKey: "codex.decision.cancel" },
    ],
    safeDecisionId: "cancel",
  });
  assert.deepEqual(result, { decision: "accept" });
});

// ---- handleServerRequest: item/tool/requestUserInput -----------------------

test("handleServerRequest (user input): a question with real options translates to a real multiple-choice UserInputQuestion", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: () => Promise.reject(new Error("not exercised in this test")),
    requestUserInput: (questions: unknown) => {
      captured = questions;
      return Promise.resolve([{ questionId: "q1", values: ["staging"] }]);
    },
  };
  const result = await codexRuntimeDef.exec.handleServerRequest(
    "item/tool/requestUserInput",
    {
      questions: [
        { id: "q1", header: "Environment", question: "Which environment?", isSecret: false, options: [{ label: "staging", description: "" }] },
      ],
    },
    host,
  );
  assert.deepEqual(captured, [{ id: "q1", header: "Environment", question: "Which environment?", options: [{ label: "staging", description: "" }], secret: false }]);
  assert.deepEqual(result, { answers: { q1: { answers: ["staging"] } } });
});

test("handleServerRequest (user input): null options translates to no options at all — free text, not an empty list forced on the client", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  let captured: unknown;
  const host = {
    requestApproval: () => Promise.reject(new Error("not exercised in this test")),
    requestUserInput: (questions: unknown) => {
      captured = questions;
      return Promise.resolve([{ questionId: "q1", values: ["a secret value"] }]);
    },
  };
  await codexRuntimeDef.exec.handleServerRequest(
    "item/tool/requestUserInput",
    { questions: [{ id: "q1", header: "", question: "What's the API key?", isSecret: true, options: null }] },
    host,
  );
  assert.deepEqual(captured, [{ id: "q1", header: undefined, question: "What's the API key?", options: undefined, secret: true }]);
});

test("handleServerRequest (user input): a \"deferred\" host response becomes an empty answers map, not a throw", async () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const host = {
    requestApproval: () => Promise.reject(new Error("not exercised in this test")),
    requestUserInput: () => Promise.resolve("deferred" as const),
  };
  const result = await codexRuntimeDef.exec.handleServerRequest(
    "item/tool/requestUserInput",
    { questions: [{ id: "q1", header: "", question: "?", isSecret: false, options: null }] },
    host,
  );
  assert.deepEqual(result, { answers: {} });
});

test("handleServerRequest: an unrecognized method returns undefined, so the connection answers method-not-found itself", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const host = { requestApproval: () => Promise.reject(new Error("n/a")), requestUserInput: () => Promise.reject(new Error("n/a")) };
  assert.equal(codexRuntimeDef.exec.handleServerRequest("some/futureMethod", {}, host), undefined);
});

test("handleServerRequest: item/permissions/requestApproval, mcpServer/elicitation/request and item/tool/call are real Codex methods but out of scope — also fall through to undefined", () => {
  if (codexRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  const host = { requestApproval: () => Promise.reject(new Error("n/a")), requestUserInput: () => Promise.reject(new Error("n/a")) };
  for (const method of ["item/permissions/requestApproval", "mcpServer/elicitation/request", "item/tool/call"]) {
    assert.equal(codexRuntimeDef.exec.handleServerRequest(method, {}, host), undefined);
  }
});

// ---- quickPrompt — codex exec's one-shot mode, confirmed live against a
// real logged-in codex-cli 0.154.0 (see codex.ts's own doc comment) --------

test("quickPrompt.buildArgs: folds systemPrompt/userPrompt into one argv string (no --system-prompt equivalent), read-only sandbox, --json", () => {
  if (codexRuntimeDef.quickPrompt.kind !== "cli") throw new Error("expected a cli quickPrompt");
  const args = codexRuntimeDef.quickPrompt.buildArgs({ systemPrompt: "You title chats.", userPrompt: "fix the login bug", cwd: "/tmp/project" });
  assert.deepEqual(args, ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--json", "You title chats.\n\nUser text:\nfix the login bug"]);
});

test("quickPrompt.extractReply: picks the LAST item.completed agent_message out of the JSONL stream", () => {
  if (codexRuntimeDef.quickPrompt.kind !== "cli") throw new Error("expected a cli quickPrompt");
  const stdout = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first draft"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Pergunta sobre versão"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1}}',
    "",
  ].join("\n");
  assert.equal(codexRuntimeDef.quickPrompt.extractReply(stdout), "Pergunta sobre versão");
});

test("quickPrompt.extractReply: undefined for a blank stream or one with no agent_message item", () => {
  if (codexRuntimeDef.quickPrompt.kind !== "cli") throw new Error("expected a cli quickPrompt");
  assert.equal(codexRuntimeDef.quickPrompt.extractReply(""), undefined);
  assert.equal(codexRuntimeDef.quickPrompt.extractReply('{"type":"turn.started"}\nnot json\n'), undefined);
});

// The three shapes `codex login status` was measured producing (codex-cli
// 0.154.0) — none of them on stdout, which stays empty in every one.
test("auth.parse: a logged-in run reports the method the sentence names", () => {
  if (codexRuntimeDef.auth.kind !== "cli-probe") throw new Error("expected cli-probe");
  assert.deepEqual(codexRuntimeDef.auth.parse({ stdout: "", stderr: "Logged in using ChatGPT\n", exitCode: 0 }), {
    loggedIn: true,
    plan: "ChatGPT",
  });
});

test("auth.parse: the WARNING line an unwritable $HOME adds doesn't hide the sentence under it", () => {
  if (codexRuntimeDef.auth.kind !== "cli-probe") throw new Error("expected cli-probe");
  const stderr = "WARNING: proceeding, even though we could not create PATH aliases: Permission denied (os error 13)\nLogged in using ChatGPT\n";
  assert.deepEqual(codexRuntimeDef.auth.parse({ stdout: "", stderr, exitCode: 0 }), { loggedIn: true, plan: "ChatGPT" });
});

test("auth.parse: the exit code decides, so a non-zero run is logged out however noisy its stderr", () => {
  if (codexRuntimeDef.auth.kind !== "cli-probe") throw new Error("expected cli-probe");
  assert.deepEqual(codexRuntimeDef.auth.parse({ stdout: "", stderr: "Not logged in\n", exitCode: 1 }), { loggedIn: false });
  assert.deepEqual(
    codexRuntimeDef.auth.parse({ stdout: "", stderr: 'Error loading configuration: CODEX_HOME points to "/nope"\n', exitCode: 1 }),
    { loggedIn: false },
  );
});

test("auth.parse: exit 0 with an unrecognized stderr is still logged in, just unlabeled", () => {
  if (codexRuntimeDef.auth.kind !== "cli-probe") throw new Error("expected cli-probe");
  assert.deepEqual(codexRuntimeDef.auth.parse({ stdout: "", stderr: "", exitCode: 0 }), { loggedIn: true });
});
