import { spawn } from "node:child_process";
import { buildChildEnv } from "../../host/childEnv.js";
import { EXTRA_PATH_DIRS, resolveAgentBin } from "../executables.js";
import type { AgentRuntimeDef, AuthStatus } from "../types.js";

const AUTH_PROBE_TIMEOUT_MS = 5000;

/** Thrown for a def whose `auth` can only be answered from inside a live
 * session — there is nothing to spawn, so the caller has to say "can't
 * check" rather than invent a `loggedIn` it didn't measure. No def in the
 * registry is in this state today; `defs/acp.ts` (a draft, unregistered)
 * is, which is exactly why this stays a real branch. */
export class AuthNotProbableError extends Error {
  constructor(runtimeId: string) {
    super(`runtime "${runtimeId}" only reports auth from inside a session`);
    this.name = "AuthNotProbableError";
  }
}

/**
 * Is this runtime logged in, under this `$HOME`?
 *
 * The def answers both halves — which binary and which args
 * (`auth.args`), and how to read what comes back (`auth.parse`) — so this
 * file never learns one CLI's output shape. What it does own is the
 * environment the probe runs under, and that part is not incidental:
 * `buildChildEnv` with the def's own `identity.env.strip` is what keeps a
 * machine with `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` exported from
 * reporting `loggedIn: true` via API key — the false positive this check
 * exists to prevent — and the `PATH` patch is what finds the binary at all
 * under a service manager's minimal `PATH`.
 */
export function probeRuntimeAuth(def: AgentRuntimeDef, homeOverride: string | undefined): Promise<AuthStatus> {
  const { auth } = def;
  if (auth.kind === "session-rpc") return Promise.reject(new AuthNotProbableError(def.identity.id));
  // A def that declares no auth at all is logged in by its own contract —
  // reporting anything else would gate a runtime on a credential it says
  // it doesn't have.
  if (auth.kind === "none") return Promise.resolve({ loggedIn: true });

  return new Promise((resolveStatus, rejectStatus) => {
    const stripCredentials = (env: NodeJS.ProcessEnv): void => {
      for (const name of def.identity.env.strip) delete env[name];
    };
    const child = spawn(resolveAgentBin(def.identity.bin), auth.args, {
      env: buildChildEnv(homeOverride, EXTRA_PATH_DIRS, stripCredentials, def.identity.env.set),
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectStatus(new Error(`${def.identity.id} auth probe timed out`));
    }, AUTH_PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectStatus(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      try {
        resolveStatus(auth.parse({ stdout, stderr, exitCode }));
      } catch (error) {
        // A CLI that printed something unparseable is a failed probe, not a
        // logged-out account: the caller turns this into "couldn't check",
        // never into a 409 that tells the user to go log in.
        rejectStatus(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
