import type { ChoiceAnswer, ChoiceQuestion } from "../bridges/mcpBridge.js";
import type { FinishedBackgroundJob } from "../host/backgroundJobs.js";

/** Text of the synthetic turn fired when an `anywh-bg`
 * job finishes. Explicit instruction to only report (not start new work nor
 * another `anywh-bg`) — without this guard, an automatic turn that already
 * has tools unlocked (same `permissionMode` as the session) could turn into
 * a chain of actions the user never asked for.
 *
 * NOTE: kept in Portuguese on purpose — this text is sent as the actual
 * synthetic user message for the turn, so its language is what the model's
 * reply (shown to the user in the chat log) will follow.
 */
export function buildBackgroundJobFollowupPrompt(job: FinishedBackgroundJob): string {
  // `terminated` is NOT a failure: the wrapper was
  // killed from the outside (`pkill`, SIGKILL, reboot) without leaving an
  // exit code behind, usually because the user or the model deliberately
  // took the process down. Saying "exit -1" here would make the model
  // report a crash that never happened.
  const status = job.terminated
    ? "foi encerrado de fora, sem exit code (morto por sinal — pkill/kill, ou a máquina reiniciou)"
    : job.exitCode === 0
      ? "concluiu com sucesso (exit 0)"
      : `terminou com erro (exit ${String(job.exitCode)})`;
  const logTail = job.logTail.trim() || "(sem saída)";
  return (
    `[anywh-bg] O processo em background "${job.label}" que você iniciou ${status}. Log (cauda):\n` +
    "```\n" +
    logTail +
    "\n```\n\n" +
    "Resuma o resultado pro usuário, de forma concisa. Isto é só um relatório automático — não inicie " +
    "trabalho novo nem rode outro anywh-bg a partir daqui; se o resultado pedir alguma ação, pergunte " +
    "antes de agir."
  );
}

/** Human-readable summary of a tool call for the generic
 * approval question in `checkPermission` below. Only the field that best
 * identifies the action is picked per tool; anything unrecognized falls
 * back to a truncated JSON dump so no call is ever unreadable, just less
 * nicely formatted than the common cases. */
export function describeToolCall(toolName: string, input: unknown): string {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  const field = (name: string): string | undefined => {
    const value = record?.[name];
    return typeof value === "string" ? value : undefined;
  };
  switch (toolName) {
    case "Bash":
      return field("command") ?? JSON.stringify(input);
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return field("file_path") ?? field("notebook_path") ?? JSON.stringify(input);
    default: {
      const json = JSON.stringify(input);
      return json.length > 200 ? `${json.slice(0, 200)}…` : json;
    }
  }
}

/** The two answers a permission prompt accepts. Ids, not labels: the label is
 * whatever the client chose to print, and matching the verdict against it is
 * what kept this one prompt untranslatable while the rest of the UI moved. */
export const APPROVE_OPTION_ID = "approve";
export const DENY_OPTION_ID = "deny";

/**
 * Builds the yes/no a blocked tool call is waiting on. Two audiences, on
 * purpose: `approval` and the option ids are for the person — the client
 * composes the question and the buttons from the parts, in whatever language
 * is selected — while `question` and the labels are the same thing in English,
 * for a client too old to know about `approval`.
 *
 * Exported so it can be tested: the real path here needs a `claude` child
 * speaking MCP's Streamable HTTP transport mid-turn, which the fake claude
 * fixture doesn't implement, so no integration test can reach it.
 */
export function buildApprovalQuestion(toolName: string, input: unknown): ChoiceQuestion {
  const isExitPlanMode = toolName === "ExitPlanMode";
  const detail = isExitPlanMode ? "" : describeToolCall(toolName, input);
  return {
    question: isExitPlanMode
      ? "The model wants to leave Plan mode and start executing. Approve?"
      : `The model wants to run \`${toolName}\`: ${detail}. Approve?`,
    approval: { tool: toolName, detail },
    options: [
      { id: APPROVE_OPTION_ID, label: "Approve" },
      { id: DENY_OPTION_ID, label: "Deny" },
    ],
  };
}

/**
 * Reads the verdict out of the answer. Anything that isn't an explicit
 * approval is a refusal — a malformed answer, an empty one, or free text that
 * matched no option must never be read as "go ahead", since what is waiting
 * on it is a command about to run on the user's machine.
 */
export function isApproved(answers: ChoiceAnswer[]): boolean {
  return answers[0]?.selected.includes(APPROVE_OPTION_ID) ?? false;
}
