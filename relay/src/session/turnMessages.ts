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
