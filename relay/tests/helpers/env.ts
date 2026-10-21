// What a test's own process may have inherited from whoever started it — a
// developer's shell, or a Claude Code session whose children carry its
// subagent limits — and must not reach the relay or the agent under test: a
// test asserting "no limit was set" then passes or fails by where it ran.
const AMBIENT_KEYS = ["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", "ANYWH_AGENT_MARK"];

/** `process.env` without the ambient settings above, nor any `RELAY_*` (each
 * test sets the ones it means, after this). For the env of a spawned child. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("RELAY_") || AMBIENT_KEYS.includes(key)) delete env[key];
  return env;
}

/** The same for this process, whose environment an in-process relay reads.
 * `RELAY_*` stay: a test file may have set its own before booting the relay. */
export function scrubAmbientEnv(): void {
  for (const key of AMBIENT_KEYS) delete process.env[key];
}
