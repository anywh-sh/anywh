// Local Claude use the relay didn't see (the CLI in a terminal, an IDE):
// any transcript of the profile written after a given instant
// (journal/99 §12.5). Only `stat` — a transcript is never opened.
//
// Transcripts live in `${CLAUDE_CONFIG_DIR:-<home>/.claude}/projects/<project>/`
// (`*.jsonl`, plus subagent ones a level or two below).
import { join } from "node:path";
import { TranscriptIndex, transcriptActivitySince } from "./transcriptIndex.js";

export function claudeProjectsDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
}

/** Whether a Claude transcript of the profile was modified after `since`
 * (epoch ms). One-off, without a cache: the service keeps a shared
 * `TranscriptIndex` instead. Never rejects. */
export async function hasClaudeActivitySince(home: string, since: number, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return transcriptActivitySince(new TranscriptIndex({ root: claudeProjectsDir(home, env) }), since);
}
