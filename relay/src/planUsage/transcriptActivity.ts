// Local Claude use the relay didn't see (the CLI in a terminal, an IDE):
// any transcript of the profile written after a given instant
// (journal/99 §12.5). Only `stat` — a transcript is never opened.
//
// Transcripts live in `${CLAUDE_CONFIG_DIR:-<home>/.claude}/projects/<project>/`
// (`*.jsonl`, plus subagent ones a level or two below).
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// projects/<project>/<session>/subagents/*.jsonl is four levels down.
const MAX_DEPTH = 4;

export function claudeProjectsDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
}

async function list(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function anyNewer(dir: string, since: number, depth: number): Promise<boolean> {
  const entries = await list(dir);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      if ((await stat(join(dir, entry.name))).mtimeMs > since) return true;
    } catch {
      // Deleted between the listing and the stat.
    }
  }
  if (depth >= MAX_DEPTH) return false;
  for (const entry of entries) {
    if (entry.isDirectory() && (await anyNewer(join(dir, entry.name), since, depth + 1))) return true;
  }
  return false;
}

/** Whether a Claude transcript of the profile was modified after `since`
 * (epoch ms). Stops at the first one. Never rejects. */
export async function hasClaudeActivitySince(home: string, since: number, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return anyNewer(claudeProjectsDir(home, env), since, 1);
}
