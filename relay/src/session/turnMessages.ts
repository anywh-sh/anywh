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
/** Sentinel the model answers with, and nothing else, when a finished job
 * needs no report. Only honoured by the relay when `offersSilence(job)` was
 * true for that turn (see `SharedSession.runTurn`). */
export const NO_REPLY = "NO_REPLY";

/** Whether the model may be offered the `NO_REPLY` escape for this result.
 * Only outcomes that can be a deliberate stop qualify: clean exit, SIGINT
 * (130), SIGTERM (143), or an external kill with no exit code. Every other
 * exit code (1, 2, 65, 124, ...) is a real failure and is never offered —
 * the relay does not decide by exit code alone what is silent, it only
 * decides what may EVER be silent. */
export function offersSilence(job: FinishedBackgroundJob): boolean {
  return job.terminated === true || job.exitCode === 0 || job.exitCode === 130 || job.exitCode === 143;
}

/** Text of the answer once normalised for the `NO_REPLY` comparison: trimmed,
 * wrapping backticks/quotes and trailing period removed. */
export function isNoReply(text: string): boolean {
  return text.trim().replace(/^[`"']+|[`"'.]+$/g, "").trim() === NO_REPLY;
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
      `não há nada a avisar: responda exatamente ${NO_REPLY} e nada mais. ` +
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
