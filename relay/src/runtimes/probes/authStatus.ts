import { spawn } from "node:child_process";
import { CLAUDE_AGENT_ENV_OVERRIDES } from "../defs/claude/index.js";
import { buildChildEnv } from "../../host/childEnv.js";
import { AGENT_BIN, EXTRA_PATH_DIRS, stripBilledCredentials } from "../executables.js";

const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 5000;

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
}

/** Pure parse of `claude auth status --json`'s stdout — pulled out of
 * `runClaudeAuthStatus` so `defs/claude/def.ts`'s `AuthSource` can reuse it
 * without duplicating the shape or re-spawning anything. Throws on invalid
 * JSON, same as the inline `JSON.parse` this replaces — `runClaudeAuthStatus`
 * below still turns that into a rejected promise. */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus {
  return JSON.parse(stdout) as ClaudeAuthStatus;
}

/** Runs `claude auth status --json` under the given `$HOME` — reuses
 * `buildChildEnv` (strips `ANTHROPIC_API_KEY`, patches `PATH`) for the exact
 * reason a real turn does: without the `PATH` patch the binary isn't found
 * under systemd's minimal `PATH`, and with `ANTHROPIC_API_KEY` present this
 * would report `loggedIn: true` via API key — the false positive this check
 * exists to prevent. */
export function runClaudeAuthStatus(homeOverride: string | undefined): Promise<ClaudeAuthStatus> {
  return new Promise((resolveStatus, rejectStatus) => {
    const child = spawn(AGENT_BIN, ["auth", "status", "--json"], {
      env: buildChildEnv(homeOverride, EXTRA_PATH_DIRS, stripBilledCredentials, CLAUDE_AGENT_ENV_OVERRIDES),
    });
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectStatus(new Error("claude auth status timed out"));
    }, CLAUDE_AUTH_STATUS_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectStatus(error);
    });
    child.on("close", () => {
      clearTimeout(timeout);
      try {
        resolveStatus(parseClaudeAuthStatus(stdout));
      } catch (error) {
        rejectStatus(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
