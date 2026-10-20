// Where one profile's agent host keeps its socket and its data. The relay and
// the host must agree on the socket path: an explicit `ANYWH_AGENT_HOST_SOCKET`
// in the profile's env file (read by both units) wins; otherwise both derive
// the same default from the profile id — the relay from `ANYWH_PROFILE` (its
// unit sets it), the host from its required `--profile` argument.
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The relay's profile: its unit sets it, and so do the npm scripts (`dev`
 * for `npm run dev`/`npm start`). `undefined` when nothing set it — then the
 * relay connects to no agent host at all rather than guess "default" and
 * reach the real one of whatever profile has that name on this machine.
 * Never inherited by the relay's children (host/childEnv.ts). */
export function relayProfile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.ANYWH_PROFILE || undefined;
}

/** The socket the relay should use, or `undefined` when it has no profile
 * and no explicit socket. */
export function relayAgentHostSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.ANYWH_AGENT_HOST_SOCKET) return env.ANYWH_AGENT_HOST_SOCKET;
  const profile = relayProfile(env);
  return profile ? defaultAgentHostSocketPath(profile, env) : undefined;
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

/** File the host writes into its data directory, holding its host id (the
 * profile): what lets anything else (deleting a profile) recognize that
 * directory as THAT profile's host's. */
export const AGENT_HOST_DIR_MARKER = ".anywh-agent-host";

const AGENT_HOST_DIR_ENTRY = /^(registry\.json(\.tmp|\.corrupt-\d+)?|logs|\.anywh-agent-host|\.anywh-agent-host-[0-9a-f]+\.lock)$/;

/** Whether a top-level entry of a data directory is one a host writes. */
export function isAgentHostDirEntry(name: string): boolean {
  return AGENT_HOST_DIR_ENTRY.test(name);
}
