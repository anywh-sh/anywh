// The turns the relay gives a bot on its own (a schedule firing, the
// person's answer to a task, its creation) all start with one prefix, so a
// transcript read back later — by the relay or by any def's history reader —
// tells them from a message the person typed and marks them the same way the
// live relay did.

export const BOT_TURN_PREFIX = "[anywh-bot]";

/** What kind of relay turn a bot prompt is, or `undefined` for anything
 * else. `label` is the schedule's name, `answer:<n>` or `created`. */
export function botTurnKind(text: string): { kind: "bot_schedule" | "bot_note"; label: string } | undefined {
  if (!text.startsWith(BOT_TURN_PREFIX)) return undefined;
  const schedule = /^\[anywh-bot\] Schedule "([^\n]*)" fired\./.exec(text);
  if (schedule) return { kind: "bot_schedule", label: schedule[1] };
  const answer = /^\[anywh-bot\] The person answered your question on task #(\d+)\./.exec(text);
  if (answer) return { kind: "bot_note", label: `answer:${answer[1]}` };
  return { kind: "bot_note", label: "created" };
}
