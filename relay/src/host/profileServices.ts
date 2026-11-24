// Stops one of a profile's two services (its relay, its agent host) when
// the profile is deleted. Two service managers run them: systemd user units
// (`anywh-relay@<id>`, `anywh-agent-host@<id>`) everywhere the relay was
// installed by install.sh, and launchd jobs (`sh.anywh.relay.<id>`,
// `sh.anywh.agent-host.<id>`) for the relay the macOS app runs
// (`ANYWH_RELAY_MANAGED_BY_APP=1`, set in those jobs' plists by
// infra/systemd/add-profile.sh).
//
// Both binaries are overridable (`SYSTEMCTL_BIN`, `LAUNCHCTL_BIN`) and read
// at call time: either one reaches the operator's real session, and a test
// must never stop a live profile that happens to share an id.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

export type ProfileService = "relay" | "agent-host";

export interface StopResult {
  /** Stopped and no longer running (or never was). */
  readonly stopped: boolean;
  /** Why not, when `stopped` is false. */
  readonly detail?: string;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => resolveRun({ code: null, stdout, stderr: String(error) }));
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

export function managedByApp(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ANYWH_RELAY_MANAGED_BY_APP === "1";
}

export function launchdLabel(service: ProfileService, id: string): string {
  return `sh.anywh.${service}.${id}`;
}

const ACTIVE_STATES = ["active", "activating", "deactivating", "reloading", "refreshing"];

async function stopSystemdUnit(service: ProfileService, id: string, env: NodeJS.ProcessEnv): Promise<StopResult> {
  const bin = env.SYSTEMCTL_BIN ?? "systemctl";
  const unit = service === "relay" ? `anywh-relay@${id}` : `anywh-agent-host@${id}`;
  // One unit per call: `systemctl disable` given several fails as a whole
  // when one does not exist (a machine set up before the host).
  const disabled = await run(bin, ["--user", "disable", "--now", unit], env);
  if (disabled.code !== 0) return { stopped: false, detail: `stopping ${unit} failed: ${disabled.stderr.trim() || `exit ${String(disabled.code)}`}` };
  // Only the host's stop gates anything (deleting its data); the relay's is
  // just logged, so it is not asked twice.
  if (service === "relay") return { stopped: true };
  const state = (await run(bin, ["--user", "is-active", unit], env)).stdout.trim();
  if (ACTIVE_STATES.includes(state)) return { stopped: false, detail: `${unit} is still ${state}` };
  return { stopped: true };
}

/** How long a job may take to go after `bootout`: a little past its plist's
 * `ExitTimeOut` (add-profile.sh: 300 s for the relay, which drains its turns,
 * 75 s for the host), when launchd SIGKILLs it. */
const LAUNCHD_SETTLE_MS: Record<ProfileService, number> = { relay: 310_000, "agent-host": 85_000 };

/** `bootout` returns before launchd has finished tearing the job down
 * (measured: `print` still finds it right after), so the verdict is `print`
 * failing, polled. `bootout`'s own exit code is not the verdict either: a
 * job that was not loaded (the user logged out since, and has not opened
 * the app) fails it while being exactly as stopped. The plist is removed
 * either way, so the app never bootstraps a deleted profile again. */
async function stopLaunchdJob(service: ProfileService, id: string, env: NodeJS.ProcessEnv, settleMs: number): Promise<StopResult> {
  const bin = env.LAUNCHCTL_BIN ?? "launchctl";
  const label = launchdLabel(service, id);
  const target = `gui/${process.getuid?.() ?? 0}/${label}`;
  const bootout = await run(bin, ["bootout", target], env);
  if (env.ANYWH_LAUNCHD_DIR) rmSync(join(env.ANYWH_LAUNCHD_DIR, `${label}.plist`), { force: true });
  const deadline = Date.now() + settleMs;
  for (;;) {
    if ((await run(bin, ["print", target], env)).code !== 0) return { stopped: true };
    if (Date.now() >= deadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return { stopped: false, detail: `${label} is still loaded (bootout: ${bootout.stderr.trim() || `exit ${String(bootout.code)}`})` };
}

export function stopProfileService(
  service: ProfileService,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  launchdSettleMs: number = LAUNCHD_SETTLE_MS[service],
): Promise<StopResult> {
  return managedByApp(env) ? stopLaunchdJob(service, id, env, launchdSettleMs) : stopSystemdUnit(service, id, env);
}
