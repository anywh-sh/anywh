/** Env for every relay child process (an agent CLI's turn, its one-shot
 * probes, and the interactive terminal) — extracted to one place because the
 * golden rule (never let a billed credential leak to the child process)
 * must hold equally for all of them: a terminal opened by the user is just
 * as capable of running the CLI manually as a turn's own spawn.
 *
 * Everything here is `where`-shaped (host env, `$HOME`, `$PATH`) except for
 * `stripCredentials`, which is `who`-shaped (only the agent whose turn this
 * is knows which env vars would make it bill per token) — passed in rather
 * than imported, so this file never has to know about `runtimes/`.
 * `agentEnvOverrides` is the same idea for the rare env var only one CLI
 * needs. */
/** The agent host's own configuration. It can sit in an env file the relay
 * shares, and a child that inherited it would make `npm run` of the host (or
 * of a test relay) inside a session aim at the profile's real host, socket
 * and data. Never passed on. */
const HOST_CONFIG_VARS = ["ANYWH_PROFILE", "ANYWH_AGENT_HOST_SOCKET", "ANYWH_AGENT_HOST_DIR", "ANYWH_AGENT_HOST_ID", "ANYWH_SESSIONS_ROOT"] as const;

export function buildChildEnv(
  homeOverride: string | undefined,
  extraPathDirs: readonly string[],
  stripCredentials: (env: NodeJS.ProcessEnv) => void,
  agentEnvOverrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of HOST_CONFIG_VARS) delete env[name];
  stripCredentials(env);
  if (homeOverride) {
    env.HOME = homeOverride;
  }
  env.PATH = [...extraPathDirs, env.PATH ?? ""].join(":");
  Object.assign(env, agentEnvOverrides);
  return env;
}
