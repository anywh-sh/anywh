// The Agent Client Protocol half every ACP def shares — request builders,
// the permission/question translation and the `configOptions` reader — so a
// def for an ACP agent (`defs/kimi.ts`) only states what is particular to
// that agent: its binary, its credentials, its mode and config ids, its
// question tool. The engine is `defs/acpDriver.ts`; the notification mapper
// is `streams/acpSessionUpdate.ts`. All pure.
//
// Method names and shapes are ACP's public vocabulary (agentclientprotocol.com),
// checked on the wire against Kimi Code CLI 2.6.0 (`kimi acp`): framing is one
// JSON value per line, `session/prompt` answers only when the turn is over
// (`{stopReason: "end_turn" | "cancelled"}`), and `session/cancel` is a
// notification.
import type { ApprovalDecision, ApprovalRequest, EffortOption, JsonRpcRequestSpec, ModelCatalog, ModelOption, TurnContext, TurnHost, UserInputQuestion } from "../types.js";

/** The client capabilities the relay offers: none. The agent reads, writes
 * and runs commands with its own tools, on the machine it already runs on,
 * and reports them as tool calls — the relay never serves its filesystem or
 * a terminal to it. */
export function acpInitialize(): JsonRpcRequestSpec {
  return { method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } };
}

/** `mcpServers` is required by the protocol; the relay declares none of its
 * own (an ACP agent asks its questions and approvals natively). */
export function acpThreadStart(ctx: TurnContext): JsonRpcRequestSpec {
  return { method: "session/new", params: { cwd: ctx.cwd, mcpServers: [] } };
}

/** Re-attaches a stored session to a fresh process without replaying it
 * (`session/load` replays, which only history needs). */
export function acpThreadResume(ctx: TurnContext, sessionId: string): JsonRpcRequestSpec {
  return { method: "session/resume", params: { sessionId, cwd: ctx.cwd, mcpServers: [] } };
}

export function acpTurnStart(ctx: TurnContext, sessionId: string): JsonRpcRequestSpec {
  return { method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: ctx.prompt }] } };
}

/** ACP has no per-turn id: cancelling names the session. Sent as a
 * notification by the driver. */
export function acpInterrupt(sessionId: string): JsonRpcRequestSpec {
  return { method: "session/cancel", params: { sessionId } };
}

export const ACP_HISTORY_METHOD = "session/load";

/** `true` for the error that means the stored session is gone (Kimi Code
 * 2.6.0 answers `-32602 "Invalid params: Unknown sessionId: <id>"` to
 * `session/prompt`, `session/resume` and `session/load` alike) — the one
 * failure after which the next turn must start a new session instead of
 * failing forever against the dead one. */
export function isAcpSessionGoneError(message: string): boolean {
  return /unknown session ?id/i.test(message);
}

// ---------------------------------------------------------------------------
// configOptions — the agent's own pickers (model, reasoning level, mode).

export interface AcpConfigOption {
  readonly id: string;
  readonly category?: string;
  readonly currentValue?: string;
  readonly options: readonly { readonly value: string; readonly name?: string; readonly description?: string }[];
}

/** The `configOptions` a `session/new`, `session/resume` or
 * `session/set_config_option` result carries; empty for any other shape. */
export function acpConfigOptions(result: unknown): readonly AcpConfigOption[] {
  const raw = (result as { configOptions?: unknown } | null)?.configOptions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (option): option is AcpConfigOption =>
      typeof option === "object" && option !== null && typeof (option as AcpConfigOption).id === "string" && Array.isArray((option as AcpConfigOption).options),
  );
}

/** The value a config option currently holds, by its `category` (`model`,
 * `thought_level`) — the protocol's stable name for what an option is,
 * whatever id an agent gives it. */
export function acpCurrentValue(options: readonly AcpConfigOption[], category: string): string | undefined {
  return options.find((option) => option.category === category)?.currentValue;
}

/** One model of the catalog, from the `thought_level` option the agent
 * reports while that model is selected — the levels differ per model
 * (Kimi Code 2.6.0: `low/high/max` on most, `on/high` on one). */
export function acpModelOption(model: { readonly value: string; readonly name?: string; readonly description?: string }, whileSelected: readonly AcpConfigOption[]): ModelOption {
  const level = whileSelected.find((option) => option.category === "thought_level");
  const efforts: EffortOption[] = (level?.options ?? []).map((option) => ({ id: option.value, ...(option.name ? { description: option.name } : {}) }));
  return {
    id: model.value,
    label: model.name ?? model.value,
    ...(model.description ? { description: model.description } : {}),
    ...(efforts.length > 0 ? { efforts, ...(level?.currentValue ? { defaultEffort: level.currentValue } : {}) } : {}),
  };
}

/** The catalog skeleton from a fresh session's `configOptions`: every model
 * the picker lists, the selected one as the default. Efforts are filled in
 * per model by the probe (`acpModelOption`). */
export function acpModelChoices(options: readonly AcpConfigOption[]): { readonly models: AcpConfigOption["options"]; readonly defaultId?: string } {
  const model = options.find((option) => option.category === "model");
  return { models: model?.options ?? [], ...(model?.currentValue ? { defaultId: model.currentValue } : {}) };
}

export function acpCatalog(options: readonly ModelOption[], defaultId: string | undefined): ModelCatalog {
  return { options, ...(defaultId ? { defaultId } : {}) };
}

// ---------------------------------------------------------------------------
// session/request_permission — approvals, and (for an agent whose question
// tool asks through it) structured questions.

interface PermissionOption {
  readonly optionId: string;
  readonly name?: string;
  readonly kind?: string;
}

export interface AcpPermissionParams {
  readonly sessionId?: string;
  readonly options?: readonly PermissionOption[];
  readonly toolCall?: {
    readonly toolCallId?: string;
    readonly title?: string;
    readonly rawInput?: unknown;
    readonly content?: readonly { readonly type?: string; readonly content?: { readonly type?: string; readonly text?: string } }[];
  };
}

/** The outcome that tells the agent the turn was cancelled with the
 * request still open — what ACP expects for every pending permission once
 * the client cancels. */
export const ACP_CANCELLED_OUTCOME = { outcome: { outcome: "cancelled" } } as const;

function selected(optionId: string): { outcome: { outcome: "selected"; optionId: string } } {
  return { outcome: { outcome: "selected", optionId } };
}

/** ACP's option kinds mapped onto the decision ids the client already has
 * translated copy for — so a Kimi approval reads "Accept / Accept for this
 * session / Decline" in the user's language like a Codex one. */
const DECISION_BY_KIND: Readonly<Record<string, ApprovalDecision>> = {
  allow_once: { id: "accept", labelKey: "acp.decision.allowOnce" },
  allow_always: { id: "acceptForSession", labelKey: "acp.decision.allowAlways" },
  reject_once: { id: "decline", labelKey: "acp.decision.rejectOnce" },
  reject_always: { id: "rejectAlways", labelKey: "acp.decision.rejectAlways" },
};

function toolCallText(params: AcpPermissionParams): string {
  return (params.toolCall?.content ?? [])
    .map((item) => (item?.type === "content" && item.content?.type === "text" ? (item.content.text ?? "") : ""))
    .join("")
    .trim();
}

/** What the call would do, for the approval sentence: the command or the
 * path from its input, else the agent's own description of the request. */
function approvalDetail(params: AcpPermissionParams): string {
  const input = params.toolCall?.rawInput as Record<string, unknown> | undefined;
  for (const key of ["command", "path", "file_path", "url", "query"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return toolCallText(params) || (params.toolCall?.title ?? "");
}

/** Builds the approval request, keeping the decision-id ↔ optionId pairing
 * so the answer can be sent back as the agent's own option. Two options of
 * the same kind keep their own ids (only the first takes the shared one). */
export function acpApprovalRequest(
  params: AcpPermissionParams,
  deferrable?: ApprovalRequest["deferrable"],
): { readonly request: ApprovalRequest; readonly optionFor: ReadonlyMap<string, string> } {
  const optionFor = new Map<string, string>();
  const decisions: ApprovalDecision[] = [];
  for (const option of params.options ?? []) {
    const known = option.kind ? DECISION_BY_KIND[option.kind] : undefined;
    const decision = known && !optionFor.has(known.id) ? known : { id: option.optionId, labelKey: option.name ?? option.optionId };
    optionFor.set(decision.id, option.optionId);
    decisions.push(decision);
  }
  const tool = params.toolCall?.title ?? "tool";
  const detail = approvalDetail(params);
  const safe = decisions.find((decision) => decision.id === "decline") ?? decisions.find((decision) => /reject/i.test(optionFor.get(decision.id) ?? ""));
  return {
    request: {
      id: params.toolCall?.toolCallId ?? crypto.randomUUID(),
      summary: toolCallText(params) || `${tool}: ${detail}`,
      detail: { kind: tool, text: detail },
      availableDecisions: decisions,
      ...(safe ? { safeDecisionId: safe.id } : {}),
      // Refusing now is only safe with a decision that says no.
      ...(deferrable && safe ? { deferrable } : {}),
    },
    optionFor,
  };
}

/** Answers an approval through the session's `TurnHost`. A host that gives
 * up (the turn was cancelled) answers `cancelled`, never a guess.
 * `deferrable` is the def's to give (see `ApprovalRequest.deferrable`): only
 * it knows whether its agent takes a refusal now and asks again later. */
export function answerAcpApproval(params: AcpPermissionParams, host: TurnHost, deferrable?: ApprovalRequest["deferrable"]): Promise<unknown> {
  const { request, optionFor } = acpApprovalRequest(params, deferrable);
  return host.requestApproval(request).then(
    (decisionId) => {
      const optionId = optionFor.get(decisionId);
      return optionId ? selected(optionId) : ACP_CANCELLED_OUTCOME;
    },
    () => ACP_CANCELLED_OUTCOME,
  );
}

/** A question asked through `session/request_permission`: the question
 * itself, and the option to answer for each label, plus the one that
 * dismisses it. */
export interface AcpQuestion {
  readonly question: UserInputQuestion;
  readonly optionForLabel: ReadonlyMap<string, string>;
  readonly dismissOptionId?: string;
}

/** Answers a question the same way an approval is answered, but through
 * `requestUserInput`, so it shows as a choice card. `"deferred"` (the
 * relay answers as the next turn) and a cancelled host both dismiss it. */
export function answerAcpQuestion(question: AcpQuestion, host: TurnHost): Promise<unknown> {
  const dismiss = question.dismissOptionId ? selected(question.dismissOptionId) : ACP_CANCELLED_OUTCOME;
  return host.requestUserInput([question.question]).then(
    (answers) => {
      if (answers === "deferred") return dismiss;
      const label = answers[0]?.values[0];
      const optionId = label !== undefined ? question.optionForLabel.get(label) : undefined;
      return optionId ? selected(optionId) : dismiss;
    },
    () => ACP_CANCELLED_OUTCOME,
  );
}
