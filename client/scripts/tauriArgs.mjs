// Pure argument/env shaping for scripts/tauri.mjs, split out so it can be
// unit-tested without spawning the Tauri CLI.

// Rejects anything that isn't a plain reverse-DNS string: the identifier
// becomes a bundle id and a file name on some platforms.
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9]+([.-][A-Za-z0-9]+)+$/;

// Subcommands whose CLI accepts `--config`. `ios`/`android` take it one level
// down (`ios build --config ...`), on every subcommand listed for them.
const CONFIG_COMMANDS = new Set(["dev", "build", "bundle"]);
const MOBILE_CONFIG_COMMANDS = new Set(["init", "dev", "build", "run"]);

/**
 * Folds ANYWH_APP_IDENTIFIER (and any TAURI_CONFIG already set) into the
 * Tauri CLI invocation.
 *
 * The CLI (2.11.4: `helpers/config.rs`, `build.rs`) never reads TAURI_CONFIG
 * for its own config: it only *writes* it, from the `--config` values alone,
 * before running cargo. A TAURI_CONFIG left in the environment therefore
 * reaches the Rust build (the binary's embedded config) when no `--config`
 * is given, never the bundler — which is how every 0.2.x macOS release
 * shipped `CFBundleIdentifier` from the checked-in placeholder while its
 * binary carried the official id (ENG-95) — and is dropped from the Rust
 * build too as soon as any `--config` is given (the Apple Silicon release
 * adds tauri.relay.conf.json).
 *
 * So the merged config goes in as one more `--config` on every command that
 * takes it, last among the CLI's own arguments (before a `--` that hands
 * the rest to the runner), where it wins like an environment override
 * should; and it stays in TAURI_CONFIG for commands that take no `--config`
 * (e.g. Xcode's `ios xcode-script` build phase).
 *
 * @param {string[]} argv arguments after `tauri`
 * @param {Record<string, string | undefined>} env
 * @returns {{ args: string[], env: Record<string, string | undefined> } | { error: string }}
 */
export function applyIdentifier(argv, env) {
  const identifier = env.ANYWH_APP_IDENTIFIER?.trim();
  if (identifier && !IDENTIFIER_PATTERN.test(identifier)) {
    return { error: `ANYWH_APP_IDENTIFIER is not a valid identifier: ${JSON.stringify(identifier)}` };
  }

  let config = env.TAURI_CONFIG || undefined;
  let nextEnv = env;
  if (identifier) {
    let existing = {};
    if (config) {
      try {
        existing = JSON.parse(config);
      } catch {
        return { error: "TAURI_CONFIG is set but is not valid JSON" };
      }
    }
    config = JSON.stringify({ ...existing, identifier });
    nextEnv = { ...env, TAURI_CONFIG: config };
  }
  if (!config || !acceptsConfig(argv)) return { args: argv, env: nextEnv };

  const end = argv.indexOf("--");
  const own = end === -1 ? argv : argv.slice(0, end);
  const rest = end === -1 ? [] : argv.slice(end);
  return { args: [...own, "--config", config, ...rest], env: nextEnv };
}

function acceptsConfig(argv) {
  const [command, subcommand] = argv;
  if (CONFIG_COMMANDS.has(command)) return true;
  return (command === "ios" || command === "android") && MOBILE_CONFIG_COMMANDS.has(subcommand);
}
