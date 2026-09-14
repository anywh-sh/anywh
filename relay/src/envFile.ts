/**
 * Parses `KEY=VALUE` lines — the same format `add-profile.sh` writes its
 * profile `.env` files in — into `target`, skipping blank lines and `#`
 * comments. An existing key in `target` wins over the file's value, same
 * precedence as Node's own `--env-file`/`--env-file-if-exists`.
 *
 * Exists because that flag is the one thing the macOS SEA binary can't
 * use: Node SEA doesn't process runtime CLI flags the way a plain `node`
 * invocation does — confirmed building it, the flag is silently ignored
 * and the process falls back to server.ts's own defaults instead of the
 * profile's `.env`. `sea-build/sea-entry.mjs` calls this against
 * `RELAY_ENV_FILE`, a plain environment variable, before importing
 * server.ts — every other launch path (dev, the Linux tarball) keeps using
 * `--env-file-if-exists` unchanged.
 */
export function applyEnvFileContent(content: string, target: NodeJS.ProcessEnv): void {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || target[key] !== undefined) continue;
    target[key] = trimmed.slice(eq + 1);
  }
}
