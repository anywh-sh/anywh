// Where a profile's Codex keeps its state, and whether it is logged in
// there at all — checked before spawning an app-server, because one pointed
// at an unused `CODEX_HOME` fills it with databases and ids (journal/99
// §2.3). `auth.json` is a credential: only its existence is checked, the
// file is never opened.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** `$CODEX_HOME`, else `<home>/.codex`, where `<home>` is the profile's
 * effective home (`RELAY_HOME_OVERRIDE`, else `$HOME`) — the same rule as
 * agentHost/codexConfig.ts. */
export function codexHomeDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(home, ".codex");
}

/** Whether `auth.json` exists as a file in the profile's Codex home. */
export async function hasCodexAuthFile(home: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    return (await stat(join(codexHomeDir(home, env), "auth.json"))).isFile();
  } catch {
    return false;
  }
}

/** Whether the profile's Codex home holds a session history: a non-empty
 * `sessions/` directory. Codex only writes a rollout there after an
 * authenticated turn, so this proves a past login — unlike the home itself
 * or its databases, which an app-server started without a login creates. */
export async function hasCodexSessions(home: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    return (await readdir(join(codexHomeDir(home, env), "sessions"))).length > 0;
  } catch {
    return false;
  }
}

/** Whether Codex has ever been logged in on this profile, as far as the
 * disk tells: a login now (`auth.json`) or a session history. */
export async function codexEverSignedInOnDisk(home: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await hasCodexAuthFile(home, env)) || (await hasCodexSessions(home, env));
}
