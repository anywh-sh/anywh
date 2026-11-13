// The `AgentRuntimeDef` for Kimi Code CLI (Moonshot AI), driven over the
// Agent Client Protocol (`kimi acp`) by the shared ACP engine
// (`defs/acpDriver.ts`). Everything ACP-generic lives in `defs/acp.ts` and
// `streams/acpSessionUpdate.ts`; this file is only what is particular to
// Kimi. Every fact below was measured against Kimi Code CLI 2.6.0, logged
// in through its own device-code flow, unless a comment says it was read
// off the binary instead.
import type { AgentRuntimeDef, ApprovalRequest, AuthProbeOutput, AuthStatus, FailureClass, JsonRpcRequestSpec, RuntimeFailure, TurnContext, TurnHost } from "../types.js";
import {
  ACP_HISTORY_METHOD,
  acpInitialize,
  acpInterrupt,
  acpThreadResume,
  acpThreadStart,
  acpTurnStart,
  answerAcpApproval,
  answerAcpQuestion,
  isAcpSessionGoneError,
  type AcpPermissionParams,
  type AcpQuestion,
} from "./acp.js";
import { acpNotificationMapping } from "../streams/acpSessionUpdate.js";

/** Kimi's question tool. It asks through `session/request_permission`, one
 * option per answer (`q0_opt_<n>`, named by the label) plus `q0_skip` — and
 * only ever the first question: given two, 2.6.0 logs "handleQuestion
 * degrading to first question only" and drops the rest. */
const QUESTION_TOOL = "AskUserQuestion";

interface QuestionInput {
  readonly questions?: readonly { readonly question?: string; readonly header?: string; readonly options?: readonly { readonly label?: string; readonly description?: string }[] }[];
}

/** The question a permission request for `AskUserQuestion` asks, from the
 * tool's own input (the driver adds it back to the request) — or, without
 * it, from the request's options and text alone. */
export function kimiQuestion(params: AcpPermissionParams): AcpQuestion {
  const asked = (params.toolCall?.rawInput as QuestionInput | undefined)?.questions?.[0];
  const optionForLabel = new Map<string, string>();
  let dismissOptionId: string | undefined;
  for (const option of params.options ?? []) {
    if (option.kind?.startsWith("reject")) dismissOptionId ??= option.optionId;
    else if (option.name) optionForLabel.set(option.name, option.optionId);
  }
  const text = (params.toolCall?.content ?? []).map((item) => item?.content?.text ?? "").join("").trim();
  const descriptions = new Map((asked?.options ?? []).flatMap((option) => (option.label && option.description ? [[option.label, option.description] as const] : [])));
  return {
    question: {
      id: params.toolCall?.toolCallId ?? "question",
      question: asked?.question ?? text,
      ...(asked?.header ? { header: asked.header } : {}),
      options: [...optionForLabel.keys()].map((label) => ({ label, ...(descriptions.has(label) ? { description: descriptions.get(label) } : {}) })),
    },
    optionForLabel,
    ...(dismissOptionId ? { dismissOptionId } : {}),
  };
}

/** Kimi words a permission request as "Requesting approval to Running: ls"
 * / "… to Writing /path". The request often arrives before any update
 * carried the call's input (measured: a Write asked first, its input came
 * after), so when the input is missing it is read back out of that
 * sentence — the command or the path is what the approval card shows. */
const APPROVAL_SENTENCE = /^Requesting approval to (?:(Running): (.+)|(Writing|Editing|Reading|Deleting) (.+)|(.+))$/s;

export function kimiApprovalParams(params: AcpPermissionParams): AcpPermissionParams {
  const toolCall = params.toolCall;
  if (!toolCall || toolCall.rawInput !== undefined) return params;
  const text = (toolCall.content ?? []).map((item) => item?.content?.text ?? "").join("").trim();
  const match = APPROVAL_SENTENCE.exec(text);
  if (!match) return params;
  const rawInput = match[1] ? { command: match[2] } : match[3] ? { path: match[4] } : undefined;
  const content = rawInput ? toolCall.content : [{ type: "content", content: { type: "text", text: match[5] } }];
  return { ...params, toolCall: { ...toolCall, ...(rawInput ? { rawInput } : {}), content } };
}

/**
 * Kimi's approvals can wait on a person for days: measured against 2.6.0, a
 * refused call ends in the tool result `Tool "Bash" was not run because the
 * user rejected the approval request.`, the model ends its turn rather than
 * look for a way around it, and told later that the call was approved it
 * asks again for the very same call (same title, same input). So the
 * session may refuse at once and keep the card (`ApprovalRequest.deferrable`).
 *
 * The repeat is recognised by the call's real input only — the one the
 * driver added back from the stream — never by the sentence: Kimi cuts a
 * long command short there ("Running: cd /a && wc…"), and a prefix must not
 * let a different command through.
 */
export function kimiDeferrable(request: AcpPermissionParams): NonNullable<ApprovalRequest["deferrable"]> {
  const tool = request.toolCall?.title;
  const input = request.toolCall?.rawInput;
  return tool && input !== undefined ? { call: { tool, input } } : {};
}

function handleServerRequest(method: string, params: unknown, host: TurnHost): Promise<unknown> | undefined {
  if (method !== "session/request_permission") return undefined;
  const request = params as AcpPermissionParams;
  if (request.toolCall?.title === QUESTION_TOOL) return answerAcpQuestion(kimiQuestion(request), host);
  return answerAcpApproval(kimiApprovalParams(request), host, kimiDeferrable(request));
}

/**
 * A failed turn as Kimi records it in its own session log
 * (`<home>/sessions/<workdir>/<session>/agents/main/wire.jsonl`, one JSON
 * record per line) — the only place it says so: measured against 2.6.0 with
 * a spent quota, `session/prompt` answers `end_turn` and no update carries
 * the error. The turn's own record is
 * `{"type":"turn.ended","reason":"failed","error":{"code":"provider.api_error","message":"You've reached your 5-hour usage limit. …"},"time":<ms>}`;
 * a turn that ended well says `"reason":"completed"` (or `"cancelled"`).
 */
export function parseKimiTurnFailure(lines: readonly string[], sinceMs: number): RuntimeFailure | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    let record: { type?: unknown; reason?: unknown; time?: unknown; error?: { message?: unknown } };
    try {
      record = JSON.parse(lines[index]) as typeof record;
    } catch {
      continue;
    }
    if (record.type !== "turn.ended") continue;
    if (typeof record.time !== "number" || record.time < sinceMs) return undefined;
    if (record.reason !== "failed") return undefined;
    const message = record.error?.message;
    return { text: typeof message === "string" && message.trim() !== "" ? message : "Kimi Code ended the turn with an error." };
  }
  return undefined;
}

/** Mode, model and reasoning level, in that order: a new model can reset
 * the level, so the level goes after it. The mode ids are Kimi's own (see
 * `permissions`); `model` and `thinking` are the ids of its two pickers. */
function configureSession(ctx: TurnContext, sessionId: string): readonly JsonRpcRequestSpec[] {
  return [
    { method: "session/set_mode", params: { sessionId, modeId: ctx.permissionModeId } },
    ...(ctx.modelId ? [{ method: "session/set_config_option", params: { sessionId, configId: "model", value: ctx.modelId } }] : []),
    ...(ctx.effortId ? [{ method: "session/set_config_option", params: { sessionId, configId: "thinking", value: ctx.effortId } }] : []),
  ];
}

/**
 * `kimi provider list`: a line per configured provider when logged in
 * (`managed:kimi-code  type=kimi  models=6  source=oauth`), `No providers
 * configured.` when not — exit 0 and an empty stderr in both states, so the
 * text is the answer. It can't tell an expired login from a valid one; a
 * turn against an expired one fails with the agent's own "Authentication
 * required" instead. Never `--json`: that variant prints each provider's
 * `apiKey`.
 */
export function parseKimiProviderList({ stdout }: AuthProbeOutput): AuthStatus {
  // The list names a provider, never an account or a plan.
  return { loggedIn: /^\S+\s+type=\S+/m.test(stdout) };
}

/** Kimi's failures arrive as JSON-RPC errors on `session/prompt`. A model
 * outside the subscription answers `-32000 "Authentication required: Your
 * current subscription does not have access to <model>"` — a plan limit,
 * not a logged-out account, despite the wording. */
export function classifyKimiFailure(failure: RuntimeFailure): FailureClass {
  if (isAcpSessionGoneError(failure.text)) return "session-invalid";
  if (/subscription does not have access|upgrade to higher-tier|quota|rate limit/i.test(failure.text)) return "usage-limit";
  if (/authentication required|not logged in|unauthorized|login/i.test(failure.text)) return "auth";
  if (/ENOENT|not found: kimi/i.test(failure.text)) return "not-installed";
  return "transient";
}

const mapping = acpNotificationMapping({ logTag: "Kimi", hiddenTools: new Set([QUESTION_TOOL]) });

export const kimiRuntimeDef: AgentRuntimeDef<undefined> = {
  identity: {
    id: "kimi",
    bin: "kimi",
    // The official installer (`install.sh`) puts the binary here and never
    // on the PATH.
    binDirs: [".kimi-code/bin"],
    // Read off the 2.6.0 binary: the env vars it takes a key from. Each one
    // bills the Moonshot account behind it (the model, web search, web
    // fetch, the registry) instead of the subscription.
    env: { strip: ["KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_MODEL_API_KEY", "KIMI_WEB_SEARCH_API_KEY", "KIMI_WEB_FETCH_API_KEY", "KIMI_REGISTRY_API_KEY"] },
    install: { url: "https://moonshotai.github.io/kimi-code/" },
    // Read off the 2.6.0 binary: it looks for `AGENTS.md` (or
    // `.kimi-code/AGENTS.md`) from the project root down to the cwd.
    projectInstructionsFile: "AGENTS.md",
  },
  capabilities: {
    // `AskUserQuestion` arrives as a structured request with an option per
    // answer (see `kimiQuestion`).
    presentChoice: "native",
    approvalPrompt: "native",
    // ACP has `session/fork`, but nothing here maps an edit onto it yet.
    rewindTurn: "none",
    replayHistory: "native",
    backgroundJobs: "none",
    // `agent_thought_chunk` carries the reasoning text itself.
    thinking: "native",
    // `usage_update {used, size}`, sent as a turn starts and after a stop.
    contextUsage: "native",
  },
  continuity: { kind: "cli-resume", resumeStyle: "capture" },
  // A throwaway session's `configOptions` (`probes/acpModelCatalog.ts`):
  // the picker's display names verbatim, and per model the reasoning levels
  // it offers (`low/high/max` on most, `on/high` on K2.7 Code Highspeed).
  // Models the subscription doesn't include are listed too — the picker
  // does the same, and a turn on one fails with a usage-limit error.
  models: { kind: "session-rpc" },
  auth: { kind: "cli-probe", args: ["provider", "list"], parse: parseKimiProviderList, loginCommand: ["login"] },
  permissions: {
    defaultModeId: "default",
    // Kimi's own four modes, ids verbatim (`session/new`'s `modes`), the
    // same on every platform: none of them depends on an OS sandbox.
    // `default` asked before `ls` but wrote a file inside the cwd without
    // asking; `auto` still asks before risky actions, questions and plans.
    // `yolo` skips every approval except one: Kimi's `dangerous-command-ask`
    // guard (read off the 2.6.0 binary, then measured) still asks before a
    // Bash command it finds destructive (`rm -rf` outside /tmp, …) in every
    // mode but `auto`. The relay keeps `yolo`'s promise by answering those
    // itself (`SharedSession.requestApproval`), so the mode never pauses.
    modesFor: () => [
      { id: "default", labelKey: "kimi.mode.default", settings: undefined, pausesForApproval: true },
      { id: "plan", labelKey: "kimi.mode.plan", settings: undefined, pausesForApproval: true },
      { id: "auto", labelKey: "kimi.mode.auto", settings: undefined, pausesForApproval: true },
      { id: "yolo", labelKey: "kimi.mode.yolo", settings: undefined, pausesForApproval: false },
    ],
  },
  bridges: [],
  // `kimi -p` works, but every call records a new session in Kimi's own
  // history ("To resume this session: kimi -r …") with no flag to skip it,
  // so each title or suggestion would leave a stray conversation behind.
  quickPrompt: { kind: "none" },
  exec: {
    kind: "jsonRpcDaemon",
    protocol: "acp",
    args: ["acp"],
    initialize: acpInitialize,
    framing: "ndjson",
    thread: { start: acpThreadStart, resume: acpThreadResume },
    turn: { start: acpTurnStart, interrupt: acpInterrupt },
    replayHistoryMethod: ACP_HISTORY_METHOD,
    configureSession,
    // Measured against 2.6.0: the only `usage_update` of a turn (with the
    // window size) arrives 0.3–1.8 ms after `session/prompt` answers —
    // never during the turn. Waiting 250 ms covers it many times over and
    // costs nothing when it comes.
    usageAfterTurnMs: 250,
    turnFailureLog: {
      // Read off the 2.6.0 binary: `KIMI_CODE_HOME`, else `~/.kimi-code`.
      home: { envVar: "KIMI_CODE_HOME", dir: ".kimi-code" },
      sessionsDir: "sessions",
      sessionLog: (sessionId) => `${sessionId}/agents/main/wire.jsonl`,
      parse: parseKimiTurnFailure,
    },
    ...mapping,
    handleServerRequest,
  },
  classifyFailure: classifyKimiFailure,
  // Measured against 2.6.0, with Kimi's own record of each model call (the
  // input of a session's first call, in its session log) as ground truth: one
  // fixed five-word prompt per directory, so the difference between two
  // directories is what the one thing that differs costs.
  //   - setup: 13,002 tokens in a directory with one unrelated file and no
  //     skills anywhere (system prompt, tools, that first message). The
  //     usage Kimi reports never isolates it — one report per turn, after
  //     the turn (`usageAfterTurnMs`) — hence `fixedSetupTokens`.
  //   - an empty directory: 13,000 (noise), so no inflation.
  //   - `AGENTS.md`: +216 for 47 cl100k tokens of English, +1,248 for 1,079,
  //     +951 for 686 of Portuguese. English alone fits a slope of exactly 1
  //     with 169 per file, but Kimi's tokenizer spends more on Portuguese than
  //     either public encoding (o200k is further off: 576 for those 951); the
  //     fit across the three, against cl100k, misses by 63 at most.
  //   - skills: +72 for one with a 7-token description, +107 at 253 tokens,
  //     +110 at 757 (the description is cut), +144 for three short ones —
  //     29 per skill, 36 for the block, descriptions cut near 42 tokens.
  //   - a subagent in `.kimi-code/agents`: +7 (noise), so none are read
  //     into the prompt, and there is no `subagents` line.
  contextAccounting: {
    encoding: "cl100k_base",
    rules: { multiplier: 1.015, perFile: 192 },
    emptyDirectoryInflation: 0,
    skills: { descriptionMaxTokens: 42, perEntry: 29, header: 36, dirs: [".kimi-code/skills", ".agents/skills"] },
    fixedSetupTokens: 13000,
  },
  // Read off the 2.6.0 binary, not measured on disk: the user-level files
  // it loads from its home (`~/.kimi-code`, `$KIMI_CODE_HOME`) and from the
  // cross-agent `~/.agents`. `config.toml` is deliberately absent: it holds
  // the OAuth tokens and API keys next to the model aliases.
  portability: {
    authoredPaths: [".kimi-code/AGENTS.md", ".kimi-code/skills", ".kimi-code/agents", ".agents/AGENTS.md"],
    // Servers live in their own `~/.kimi-code/mcp.json` (`mcpServers`), but
    // the CLI has no `mcp login` to drive and its OAuth callback was never
    // observed, so nothing here can claim a login flow.
    mcp: { kind: "none" },
  },
};
