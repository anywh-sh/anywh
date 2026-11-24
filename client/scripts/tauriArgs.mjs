// The Tauri CLI reads TAURI_CONFIG only when no `--config` is given: the
// variable is the flag's fallback, not a layer merged with it. A build that
// passes its own `--config` (the Apple Silicon release adds
// tauri.relay.conf.json) would silently drop the identifier TAURI_CONFIG
// carries, and the official app would ship as the development one, with
// another data directory. So TAURI_CONFIG is passed on as one more
// `--config`, last, where it wins like it does on its own: last among the
// CLI's own arguments, before a `--` that hands the rest to the runner.
export function withEnvConfig(args, tauriConfig) {
  if (!tauriConfig) return args;
  const end = args.indexOf("--");
  const own = end === -1 ? args : args.slice(0, end);
  const hasConfig = own.some((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config=") || (arg.startsWith("-c") && arg.length > 2 && !arg.startsWith("--")));
  if (!hasConfig) return args;
  return end === -1 ? [...args, "--config", tauriConfig] : [...own, "--config", tauriConfig, ...args.slice(end)];
}
