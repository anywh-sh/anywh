import type { Dictionary } from "@/i18n/dictionary";
import type { ChoiceOption, ChoiceQuestion } from "@/lib/relay/relayClient";

/** What an answer carries for this option. The relay's own options (a
 * permission prompt) answer with a stable id, because the label the user
 * reads is written here and translated; the model's options answer with
 * the label itself, which is what gets fed back to the model. */
export function optionValue(option: ChoiceOption): string {
  return option.id ?? option.label;
}

/** The label to print. An option the relay wrote carries an id this app
 * already has copy for; an option the model wrote carries only its label,
 * which is the model's own words and belongs on screen as written. */
export function optionLabel(option: ChoiceOption, dict: Dictionary): string {
  if (option.id === "approve") return dict.chat.approval.approve;
  if (option.id === "deny") return dict.chat.approval.deny;
  if (option.id === "accept") return dict.chat.approval.codexAccept;
  if (option.id === "acceptForSession") return dict.chat.approval.codexAcceptForSession;
  if (option.id === "decline") return dict.chat.approval.codexDecline;
  if (option.id === "cancel") return dict.chat.approval.codexCancel;
  if (option.id === "rejectAlways") return dict.chat.approval.rejectAlways;
  return option.label;
}

/** A permission prompt is composed here rather than sent as a sentence, so
 * it follows the selected language. `question` stays the fallback for a
 * relay too old to send the parts. */
export function questionText(current: ChoiceQuestion, dict: Dictionary): string {
  if (!current.approval) return current.question;
  if (current.approval.tool === "ExitPlanMode") return dict.chat.approval.exitPlanMode;
  const base =
    current.approval.tool === "command" || current.approval.tool === "writeStdin"
      ? dict.chat.approval.codexCommand.replace("{detail}", current.approval.detail)
      : current.approval.tool === "fileChange"
        ? dict.chat.approval.codexFileChange.replace("{detail}", current.approval.detail)
        : dict.chat.approval.toolCall.replace("{tool}", current.approval.tool).replace("{detail}", current.approval.detail);
  return current.approval.reason ? `${base} ${dict.chat.approval.reasonSuffix.replace("{reason}", current.approval.reason)}` : base;
}

/** Whether a question takes a free-text answer. Gated on this specific
 * question having no options to pick from, not on `kind`: a
 * `kind: "approval"` question with real options (a permission prompt, or a
 * native multiple-choice user-input question) matches the answer against
 * option ids the engine sent, and free text matches none of them, so
 * offering it there would only ever stall the blocked call — but a
 * `kind: "approval"` user-input question with NO options is the engine's own
 * honest signal that it wants free text, same as `kind: "choice"` always has. */
export function allowsCustomText(kind: "approval" | "choice", question: ChoiceQuestion): boolean {
  return kind === "choice" || question.options.length === 0;
}
