import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { isSea } from "node:sea";

// The PATH a relay started by a service manager runs with is not the user's.
// launchd hands a Homebrew service `/usr/bin:/bin:/usr/sbin:/sbin`, a systemd
// user manager barely more, and neither sources the shell profile where nvm,
// volta, asdf, bun or Homebrew put themselves. An agent CLI installed with
// `npm i -g` is a `#!/usr/bin/env node` script: even found by absolute path it
// dies on the spot without `node` on PATH, and detection reads that as "not
// installed". A real first run on a Mac with Claude Code and Codex both
// installed through npm ended on "No agent found" for exactly this reason.
//
// So the relay widens its own PATH once, at boot, before anything spawns:
// every child (detection, turns, probes, logins, the embedded terminal)
// builds its env from `process.env`, and inherits the fix without each spawn
// site having to know. The relay's own PATH stays first, untouched: what it
// already resolved resolves the same, a relay started from a shell behaves
// exactly as before, and a test's fake binary still wins. Only directories
// that exist and aren't already there are appended after it.

/** Disables the whole widening — set by the test helpers, whose relay must
 * see only the PATH the test gave it. */
export const AGENT_PATH_DISCOVERY_ENV = "ANYWH_AGENT_PATH_DISCOVERY";

const LOGIN_SHELL_TIMEOUT_MS = 3000;
const MARK = "__ANYWH_PATH__";

/** `current` first, as it was, then every absolute dir of `extra` it
 * doesn't already have, in order. */
export function widenPath(current: string | undefined, extra: readonly string[]): string {
  const dirs = (current ?? "").split(delimiter).filter((dir) => dir.length > 0);
  const seen = new Set(dirs);
  for (const dir of extra) {
    if (!isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs.join(delimiter);
}

/** The PATH between the two markers of the login shell's output — anything a
 * shell profile prints around it (a banner, a motd) is ignored. */
export function parseShellPath(stdout: string): string[] {
  const match = stdout.match(new RegExp(`${MARK}(.*?)${MARK}`, "s"));
  if (!match) return [];
  return match[1]
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => isAbsolute(dir));
}

function numericVersion(name: string): number[] | undefined {
  const match = name.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : undefined;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * nvm's `bin` for the version a new shell would get: the highest installed
 * version matching the `default` alias when it names a version prefix
 * (`20`, `v20.19`, `20.19.0`), else the highest installed overall (`node`,
 * `lts/*`, or no alias at all).
 */
export function pickNvmVersion(installed: readonly string[], alias: string | undefined): string | undefined {
  const versions = installed.flatMap((name) => {
    const version = numericVersion(name);
    return version ? [{ name, version }] : [];
  });
  versions.sort((a, b) => compareVersions(b.version, a.version));
  const prefix = alias?.trim().replace(/^v/, "");
  if (prefix && /^\d+(\.\d+){0,2}$/.test(prefix)) {
    const parts = prefix.split(".").map(Number);
    const match = versions.find(({ version }) => parts.every((part, i) => version[i] === part));
    if (match) return match.name;
  }
  return versions[0]?.name;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function nvmBin(nvmDir: string): string | undefined {
  let installed: string[];
  try {
    installed = readdirSync(join(nvmDir, "versions", "node"));
  } catch {
    return undefined;
  }
  const version = pickNvmVersion(installed, readText(join(nvmDir, "alias", "default")));
  return version ? join(nvmDir, "versions", "node", version, "bin") : undefined;
}

/** `prefix=` of the user's `~/.npmrc` — where `npm i -g` installs when the
 * user moved it out of a root-owned dir. */
function npmPrefixBin(home: string): string | undefined {
  const prefix = readText(join(home, ".npmrc"))?.match(/^\s*prefix\s*=\s*(.+?)\s*$/m)?.[1];
  if (!prefix) return undefined;
  const expanded = prefix.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home);
  return isAbsolute(expanded) ? join(expanded, "bin") : undefined;
}

/**
 * Where agent CLIs, and the `node` an npm-installed one runs on, land for one
 * user: per-user bin dirs, Node version managers, package managers' global
 * bins, Homebrew. Candidates only — `discoverAgentPath` keeps the ones that
 * exist.
 */
export function candidateToolDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  const dirs = [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    npmPrefixBin(home),
    join(home, ".npm-global", "bin"),
    nvmBin(env.NVM_DIR ?? join(home, ".nvm")),
    join(home, ".volta", "bin"),
    ...[env.FNM_DIR, join(home, ".local", "share", "fnm"), join(home, "Library", "Application Support", "fnm"), join(home, ".fnm")]
      .filter((dir): dir is string => !!dir)
      .map((dir) => join(dir, "aliases", "default", "bin")),
    join(env.ASDF_DATA_DIR ?? join(home, ".asdf"), "shims"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".bun", "bin"),
    env.PNPM_HOME,
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
    join(home, ".yarn", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
  ];
  return dirs.filter((dir): dir is string => !!dir);
}

/**
 * The PATH the user's own login shell ends up with — the one place that knows
 * about a version manager or install location nobody listed. Interactive as
 * well as login (`-ilc`), because nvm, bun and friends write themselves into
 * `.zshrc`/`.bashrc`, not the login profile. Bounded: a profile that hangs or
 * waits for input costs at most the timeout, and any failure is just no
 * extra dirs.
 */
export function readLoginShellPath(env: NodeJS.ProcessEnv, shell?: string, timeoutMs = LOGIN_SHELL_TIMEOUT_MS): string[] {
  let program = shell ?? env.SHELL;
  if (!program) {
    try {
      program = userInfo().shell ?? undefined;
    } catch {
      program = undefined;
    }
  }
  if (!program) return [];
  const result = spawnSync(program, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...env, [AGENT_PATH_DISCOVERY_ENV]: "0" },
  });
  return typeof result.stdout === "string" ? parseShellPath(result.stdout) : [];
}

export interface DiscoverOptions {
  readonly home?: string;
  readonly shell?: string;
  readonly platform?: NodeJS.Platform;
  /** Dir of the `node` running the relay — a systemd unit names it by
   * absolute path, so it's on no PATH, yet it's where `npm i -g` installed.
   * `null` for none. */
  readonly nodeDir?: string | null;
  readonly loginShell?: boolean;
}

/** The dirs to append to `env.PATH`: the login shell's, then the relay's own
 * `node`'s, then the well-known ones — kept only when they exist and aren't
 * already on it. */
export function discoverAgentPath(env: NodeJS.ProcessEnv, options: DiscoverOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || env[AGENT_PATH_DISCOVERY_ENV] === "0") return [];
  const home = options.home ?? homedir();
  const nodeDir = options.nodeDir !== undefined ? options.nodeDir : isSea() ? null : dirname(process.execPath);
  const candidates = [
    ...(options.loginShell === false ? [] : readLoginShellPath(env, options.shell)),
    ...(nodeDir ? [nodeDir] : []),
    ...candidateToolDirs(home, env),
  ];
  const current = new Set((env.PATH ?? "").split(delimiter));
  return [...new Set(candidates)].filter((dir) => !current.has(dir) && isDir(dir));
}

/** Widens `env.PATH` (the process's own by default) in place, once at boot.
 * Returns the dirs it appended, for the boot log. */
export function widenAgentPath(env: NodeJS.ProcessEnv = process.env, options: DiscoverOptions = {}): string[] {
  const added = discoverAgentPath(env, options);
  if (added.length > 0) env.PATH = widenPath(env.PATH, added);
  return added;
}
