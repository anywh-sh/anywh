import type { ChoiceAnswer, ChoiceQuestion } from "./mcpBridge.js";

// Text-marker fallback for `plan` mode, where the real
// `present_choice` MCP tool (mcpBridge.ts) can't be offered: plan mode
// blocks any non-native tool categorically, no known
// workaround. The format below was validated against the real binary
// (Descoberta 2) — the model reliably discriminates it from an open-ended
// request for detail and only uses it for a genuinely closed decision. It's
// a weaker guarantee than tool-calling (depends on the model choosing to
// follow the format), but plan mode is inherently textual anyway — it
// produces a written plan, not tool calls — so parsing text here isn't a
// workaround, it's the native shape that mode already speaks in.
export const PLAN_MODE_CHOICE_MARKER_PROMPT =
  "When you need the human to make a genuinely closed decision among a fixed set of options while " +
  "planning (not an open-ended request for more detail — keep those as normal prose), ask using " +
  "exactly this format, verbatim:\n\n" +
  ">>>QUESTION: <question>\n" +
  "- <option 1>\n" +
  "- <option 2>\n" +
  ">>>END\n\n" +
  "Wait for the answer before continuing the plan.";

const MARKER_REGEX = />>>QUESTION:[ \t]*(.+?)\r?\n([\s\S]*?)>>>END/g;

/** Parses every `>>>QUESTION:...>>>END` block out of a plan-mode response.
 * One `ChoiceQuestion` per block, in order — a single response can ask more
 * than one closed question, same as `present_choice` supports multiple in
 * one call. A block with no valid `- option` line is dropped rather than
 * treated as an error: there's nothing sensible to render for it, and the
 * caller only cares whether the final list is non-empty. */
export function parsePlanChoiceMarkers(text: string): ChoiceQuestion[] {
  const questions: ChoiceQuestion[] = [];
  for (const match of text.matchAll(MARKER_REGEX)) {
    const question = match[1].trim();
    const options = match[2]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => ({ label: line.slice(2).trim() }))
      .filter((option) => option.label.length > 0);
    if (question && options.length > 0) questions.push({ question, options });
  }
  return questions;
}

/** Turns the human's answer back into plain text. Named for the plan-mode
 * marker path but shared verbatim by the MCP `present_choice` path too
 * (the deferred-lifecycle path) — both feed the same `pendingChoice` slot in
 * `SharedSession` now, and both have the exact same problem this solves:
 * there's no live `claude` process holding a tool call open to return an
 * answer to (the turn that asked already ended, or ended immediately after
 * asking), so the answer becomes the next ordinary user message instead,
 * same as if they'd typed it in the composer themselves
 * (`SharedSession.answerChoice` enqueues it as a real turn). Kept in
 * Portuguese on purpose, like `buildBackgroundJobFollowupPrompt` in
 * sharedSession.ts — this is the literal text of a synthetic user turn, so
 * its language is what the model's reply (shown to the user) will follow. */
export function formatPlanChoiceAnswerText(answers: ChoiceAnswer[]): string {
  const format = (answer: ChoiceAnswer) => answer.selected.join(", ") || "(nenhuma opção selecionada)";
  if (answers.length === 1) return format(answers[0]);
  return answers.map((answer) => `${answer.question}: ${format(answer)}`).join("\n");
}
