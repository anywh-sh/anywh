import type { FinishedBackgroundJob } from "../host/backgroundJobs.js";
import { isQuietExit } from "../host/backgroundJobs.js";
import { SILENCE_OFFER_MARKER } from "../protocol/silentEvents.js";

export { NO_REPLY, isNoReply } from "../protocol/silentEvents.js";

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
/** Whether the model may be offered the `NO_REPLY` escape for this result.
 * Only outcomes that can be a deliberate stop qualify: clean exit, SIGINT
 * (130), SIGTERM (143), or an external kill with no exit code. Every other
 * exit code (1, 2, 65, 124, ...) is a real failure and is never offered —
 * the relay does not decide by exit code alone what is silent, it only
 * decides what may EVER be silent. */
export function offersSilence(job: FinishedBackgroundJob): boolean {
  return isQuietExit(job);
}

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
  const header =
    `[anywh-bg] O processo em background "${job.label}" que você iniciou ${status}. Log (cauda):\n` +
    "```\n" +
    logTail +
    "\n```\n\n";
  if (offersSilence(job)) {
    return (
      header +
      "Resuma o resultado pro usuário, de forma concisa, se houver algo que ele precise saber. " +
      `Se o contexto desta conversa mostrar que você ou o usuário encerrou esse processo de propósito, ` +
      "ou que o resultado dele já foi lido e relatado (por exemplo, você o leu com `anywh-bg status`), " +
      `não há nada a avisar: ${SILENCE_OFFER_MARKER}. ` +
      "Sem essa evidência na conversa, escreva uma linha curta com o resultado — exit 0 com log vazio ou " +
      "mascarado por `| tail` ou redirecionamento não é evidência. " +
      "Isto é só um relatório automático — não inicie trabalho novo nem rode outro anywh-bg a partir daqui; " +
      "se o resultado pedir alguma ação, pergunte antes de agir."
    );
  }
  return (
    header +
    "Resuma o resultado pro usuário, de forma concisa. Isto é só um relatório automático — não inicie " +
    "trabalho novo nem rode outro anywh-bg a partir daqui; se o resultado pedir alguma ação, pergunte " +
    "antes de agir."
  );
}

/** One call of a deferred approval, with the human's verdict. */
export interface DeferredApprovalDecision {
  tool: string;
  /** What the call does, as the approval card showed it. */
  detail: string;
  approved: boolean;
  agentId?: string;
}

/**
 * The message that starts the turn after a human answered a deferred tool
 * approval. The permission itself is granted mechanically (the turn is spawned
 * with it); this text only tells the model the answer so it repeats the calls
 * that were allowed and leaves the refused ones alone. English on purpose: it
 * is an instruction to the model, and the earlier refusal it answers was
 * English too.
 */
export function buildDeferredApprovalFollowup(decisions: readonly DeferredApprovalDecision[]): string {
  const line = ({ tool, detail, agentId }: DeferredApprovalDecision): string =>
    `- ${[tool, detail].filter(Boolean).join(" ")}${agentId ? ` (from subagent ${agentId})` : ""}`;
  const approved = decisions.filter((decision) => decision.approved);
  const denied = decisions.filter((decision) => !decision.approved);
  const sections: string[] = [];
  if (approved.length > 0) {
    const exitsPlan = approved.some((decision) => decision.tool === "ExitPlanMode");
    sections.push(
      `approved: retry the denied call${approved.length > 1 ? "s" : ""}. The user approved ${approved.length > 1 ? "these calls" : "this call"}; ` +
        `repeat ${approved.length > 1 ? "them" : "it"} exactly as before, without asking again` +
        `${exitsPlan ? " (the plan was approved: leave plan mode and carry it out)" : ""}:\n${approved.map(line).join("\n")}`,
    );
  }
  if (denied.length > 0) {
    const many = denied.length > 1;
    sections.push(
      `denied by the user: do not retry ${many ? "these calls" : "this call"} or look for another way around the refusal. ` +
        `Continue without ${many ? "them" : "it"}, or ask the user what to do instead:\n${denied.map(line).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
