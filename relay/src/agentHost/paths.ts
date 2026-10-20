// Where one profile's agent host keeps its socket and its data. The relay and
// the host must agree on the socket path; both read the same per-profile env
// file under systemd, so an explicit `ANYWH_AGENT_HOST_SOCKET` there wins.
// Without it, both derive the same default from the profile id.
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function agentHostProfile(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANYWH_PROFILE || "default";
}

/** The socket's directory must be private to the user (the socket server
 * enforces 0700), so it is never a shared directory itself. */
export function defaultAgentHostSocketPath(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  const base = runtimeDir ? join(runtimeDir, "anywh") : join(tmpdir(), `anywh-${process.getuid?.() ?? "user"}`);
  return join(base, `agent-host-${profile}.sock`);
}

export function agentHostSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANYWH_AGENT_HOST_SOCKET || defaultAgentHostSocketPath(agentHostProfile(env), env);
}

/** Registry and per-agent logs. Next to the relay's own per-profile files. */
export function agentHostDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANYWH_AGENT_HOST_DIR || join(homedir(), ".anywh-sessions", `${agentHostProfile(env)}-agent-host`);
}
