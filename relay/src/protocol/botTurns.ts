// The turns the relay gives a bot on its own (a schedule firing, the
// person's answer to a task, its creation) all start with one prefix, so a
// transcript read back later — by the relay or by any def's history reader —
// tells them from a message the person typed and marks them the same way the
// live relay did.

export const BOT_TURN_PREFIX = "[anywh-bot]";

/** The bot's own tools that only look something up: calling one does not
 * cost a scheduled run its silence, live (`HeldTurn`) or read back. */
export const BOT_LOOKUP_TOOLS: ReadonlySet<string> = new Set(["bot_status", "bot_list"]);

/** What kind of relay turn a bot prompt is, or `undefined` for anything
 * else (a message the person typed, even one starting with the prefix). `label` is the schedule's name, `answer:<n>`, `cancel:<n>`, `created`,
 * or, for what another bot sent (`session/botPeers.ts`), `peer_ask:<bot>`,
 * `peer_answer:<bot>`, `peer_noanswer:<bot>`, `peer_handoff:<n>:<bot>` or
 * `peer_closed:<n>:<bot>`. */
export function botTurnKind(text: string): { kind: "bot_schedule" | "bot_note"; label: string } | undefined {
  if (!text.startsWith(BOT_TURN_PREFIX)) return undefined;
  const schedule = /^\[anywh-bot\] Schedule "([^\n]*)" fired\./.exec(text);
  if (schedule) return { kind: "bot_schedule", label: schedule[1] };
  const answer = /^\[anywh-bot\] The person answered your question on task #(\d+)\./.exec(text);
  if (answer) return { kind: "bot_note", label: `answer:${answer[1]}` };
  const cancel = /^\[anywh-bot\] The person canceled task #(\d+)\./.exec(text);
  if (cancel) return { kind: "bot_note", label: `cancel:${cancel[1]}` };
  if (/^\[anywh-bot\] You were just created\./.test(text)) return { kind: "bot_note", label: "created" };
  // A bot's name is one line and may hold quotes: the greedy match backs off
  // to the last spot where the fixed words follow.
  const ask = /^\[anywh-bot\] Bot "([^\n]*)" asks you:/.exec(text);
  if (ask) return { kind: "bot_note", label: `peer_ask:${ask[1]}` };
  const peerAnswer = /^\[anywh-bot\] Bot "([^\n]*)" answered your question\./.exec(text);
  if (peerAnswer) return { kind: "bot_note", label: `peer_answer:${peerAnswer[1]}` };
  const noAnswer = /^\[anywh-bot\] Bot "([^\n]*)" could not answer your question/.exec(text);
  if (noAnswer) return { kind: "bot_note", label: `peer_noanswer:${noAnswer[1]}` };
  const handoff = /^\[anywh-bot\] Bot "([^\n]*)" handed you task #(\d+)\.$/m.exec(text.split("\n", 1)[0]);
  if (handoff) return { kind: "bot_note", label: `peer_handoff:${handoff[2]}:${handoff[1]}` };
  // The title another bot wrote is on a line of its own, below: it cannot
  // shift the name or the number read from the first line.
  const closed = /^\[anywh-bot\] Bot "([^\n]*)" closed task #(\d+) you handed off: [a-z ()]+\.$/.exec(text.split("\n", 1)[0]);
  if (closed) return { kind: "bot_note", label: `peer_closed:${closed[2]}:${closed[1]}` };
  // The prefix alone is not the relay's: a person may type it.
  return undefined;
}
