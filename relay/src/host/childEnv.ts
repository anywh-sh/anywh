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
export function buildChildEnv(
  homeOverride: string | undefined,
  extraPathDirs: readonly string[],
  stripCredentials: (env: NodeJS.ProcessEnv) => void,
  agentEnvOverrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  stripCredentials(env);
  if (homeOverride) {
    env.HOME = homeOverride;
  }
  env.PATH = [...extraPathDirs, env.PATH ?? ""].join(":");
  Object.assign(env, agentEnvOverrides);
  return env;
}
