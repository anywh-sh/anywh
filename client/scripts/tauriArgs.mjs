// The Tauri CLI reads TAURI_CONFIG only when no `--config` is given: the
// variable is the flag's fallback, not a layer merged with it. A build that
// passes its own `--config` (the Apple Silicon release adds
// tauri.relay.conf.json) would silently drop the identifier TAURI_CONFIG
// carries, and the official app would ship as the development one, with
// another data directory. So TAURI_CONFIG is passed on as one more
// `--config`, last, where it wins like it does on its own.
export function withEnvConfig(args, tauriConfig) {
  if (!tauriConfig) return args;
  const hasConfig = args.some((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config=") || (arg.startsWith("-c") && arg.length > 2 && !arg.startsWith("--")));
  return hasConfig ? [...args, "--config", tauriConfig] : args;
}
