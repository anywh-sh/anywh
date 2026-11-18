import { spawn } from "node:child_process";
import { buildChildEnv, childHome, type ChildTarget } from "../../host/childEnv.js";
import { EXTRA_PATH_DIRS, resolveRuntimeBin } from "../executables.js";
import type { AgentRuntimeDef } from "../types.js";

const LOGOUT_TIMEOUT_MS = 15_000;

/** Signs this CLI out under `homeOverride` with its own logout
 * (`auth.logout`), so whatever its login stored goes the way the CLI itself
 * removes it. Resolves with the CLI's exit; rejects only when it can't be
 * run at all or doesn't answer in time. */
export function runAgentLogout(def: AgentRuntimeDef, homeOverride: ChildTarget): Promise<{ readonly ok: boolean; readonly detail?: string }> {
  const args = def.auth.logout;
  if (!args) return Promise.reject(new Error(`runtime "${def.identity.id}" declares no logout`));
  const stripCredentials = (env: NodeJS.ProcessEnv): void => {
    for (const name of def.identity.env.strip) delete env[name];
  };
  return new Promise((resolveLogout, rejectLogout) => {
    const child = spawn(resolveRuntimeBin(def.identity), [...args], {
      cwd: childHome(homeOverride),
      env: buildChildEnv(homeOverride, EXTRA_PATH_DIRS, stripCredentials, def.identity.env.set),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const timeout = setTimeout(() => {
      child.kill();
      rejectLogout(new Error(`${def.identity.id} logout timed out`));
    }, LOGOUT_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectLogout(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const detail = output.trim().split("\n").at(-1)?.trim();
      resolveLogout(code === 0 ? { ok: true } : detail ? { ok: false, detail } : { ok: false });
    });
  });
}
