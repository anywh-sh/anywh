// Where one profile's agent host keeps its socket and its data. The relay and
// the host must agree on the socket path: an explicit `ANYWH_AGENT_HOST_SOCKET`
// in the profile's env file (read by both units) wins; otherwise both derive
// the same default from the profile id — the relay from `ANYWH_PROFILE` (its
// unit sets it), the host from its required `--profile` argument.
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The relay's profile. Never inherited by the relay's children (see
 * host/childEnv.ts), so a relay started from inside a session does not
 * silently take over the session's profile. */
export function relayProfile(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANYWH_PROFILE || "default";
}

/** The socket's directory must be private to the user (the socket server
 * enforces 0700), so it is never a shared directory itself. */
export function defaultAgentHostSocketPath(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  const base = runtimeDir ? join(runtimeDir, "anywh") : join(tmpdir(), `anywh-${process.getuid?.() ?? "user"}`);
  return join(base, `agent-host-${profile}.sock`);
}

export function agentHostSocketPath(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.ANYWH_AGENT_HOST_SOCKET || defaultAgentHostSocketPath(profile, env);
}

/** Where per-profile files live (`~/.anywh-sessions`, like the relay's
 * sessions file). `ANYWH_SESSIONS_ROOT` moves it — tests point it at a temp
 * dir so nothing they do can reach a real profile's data. */
export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANYWH_SESSIONS_ROOT || join(homedir(), ".anywh-sessions");
}

/** Registry and per-agent logs of a profile's host. */
export function agentHostDataDir(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.ANYWH_AGENT_HOST_DIR || join(sessionsRoot(env), `${profile}-agent-host`);
}
