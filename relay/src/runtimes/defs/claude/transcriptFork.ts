import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractHumanText, type TranscriptLine } from "./transcriptReader.js";

/**
 * Message editing — truncates the `.jsonl` file that the Claude
 * Code CLI maintains on its own, at the exact point of the message the user
 * edited, and writes the result as a new session (new `session_id`). This is
 * the only real way to "restart the conversation from here": the `claude`
 * CLI has no "resume cutting in the middle" flag (confirmed in `--help`:
 * only `--resume`/`--fork-session`, always from the tip) — without this, the
 * next `--resume` would reread the whole file (old message + everything that
 * came after) and send that "wrong" history to the API, even with the UI
 * already hiding the edited message.
 *
 * `turnsToKeep` is the count of turns (`user` lines with genuine human text,
 * same criterion as `transcriptReader.ts`) that must survive the cut —
 * computed by the caller (`SharedSession`) from the in-memory `history`,
 * which is what knows how to distinguish a synthetic `anywh-bg` turn from a
 * real one (the file itself doesn't mark that difference). Since each turn,
 * real or synthetic, corresponds to exactly one `claude -p` call and
 * therefore exactly one line in the `.jsonl`, counting the same way on both
 * sides always matches — no need to reconstruct the real/synthetic
 * distinction here.
 */
export function forkTruncatedTranscript(path: string, turnsToKeep: number): string {
  const rawLines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);

  let seen = 0;
  let cutAt = rawLines.length;
  for (let i = 0; i < rawLines.length; i++) {
    let line: TranscriptLine;
    try {
      line = JSON.parse(rawLines[i]) as TranscriptLine;
    } catch {
      continue; // same tolerance as transcriptReader.ts — only the last line can arrive broken.
    }
    if (line.type !== "user") continue;
    // Only the genuine human text line counts as the start of a turn — same
    // criterion as `transcriptReader.ts`. `tool_result` (`isToolResultOnly`)
    // doesn't start a turn, it's feedback from the agentic loop itself.
    const humanText = extractHumanText(line);
    if (humanText === undefined) continue;
    if (seen === turnsToKeep) {
      cutAt = i;
      break;
    }
    seen++;
  }

  const kept = rawLines.slice(0, cutAt);
  const newSessionId = randomUUID();
  const rewritten = kept.map((rawLine) => {
    const parsed = JSON.parse(rawLine) as TranscriptLine;
    parsed.sessionId = newSessionId;
    return JSON.stringify(parsed);
  });

  const newPath = join(dirname(path), `${newSessionId}.jsonl`);
  writeFileSync(newPath, rewritten.length > 0 ? rewritten.join("\n") + "\n" : "");
  return newSessionId;
}
