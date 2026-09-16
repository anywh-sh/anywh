import { connect, createServer } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Host-side registry of relay profiles — every profile this
// machine can run, independent of which one the current process happens to
// be. `homedir()`, never `process.env.HOME`: the current process may itself
// be running with an overridden `$HOME` (a `trabalho` instance), but the
// registry always lives under the real user's home.
//
// Mirror of ENV_DIR in infra/lib.sh — keep both in sync (systemd's
// `EnvironmentFile` can't share this constant across the language boundary).
export const ENV_DIR = process.env.ANYWH_ENV_DIR ?? join(homedir(), ".config/anywh/env");

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface HostProfile {
  id: string;
  label: string;
  colorIndex: number;
  host: string;
  port: number;
  hasHomeOverride: boolean;
  running: boolean;
  /** Absent means the built-in theme. Lives here, in the host registry,
   * rather than in the client's local settings, because the theme has to
   * follow the profile across devices the same way its label does. */
  themeId?: string;
}

export interface ProfileMeta {
  id: string;
  label: string;
  colorIndex?: number;
  themeId?: string;
  createdAt: string;
  updatedAt: string;
}

interface ProfilesJson {
  version: 1;
  profiles: ProfileMeta[];
}

export function envFileFor(id: string, envDir: string = ENV_DIR): string {
  return join(envDir, `${id}.env`);
}

export function isValidProfileId(id: string): boolean {
  return id.length > 0 && id.length <= 32 && PROFILE_ID_PATTERN.test(id);
}

/** NFD + strip accents, lowercase, non-alphanumeric collapsed to `-`, capped
 * at 32 chars, suffixed with `-2`/`-3`... on collision with `taken`. Runs on
 * the relay, not the client: the relay owns the filesystem namespace and is
 * the only side that can check collisions without a race. */
export function slugify(label: string, taken: string[]): string {
  const base =
    label
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "profile";

  if (!taken.includes(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

function listEnvIds(envDir: string): string[] {
  if (!existsSync(envDir)) return [];
  return readdirSync(envDir)
    .filter((name) => name.endsWith(".env"))
    .map((name) => name.slice(0, -".env".length));
}

function readEnvFile(id: string, envDir: string): Record<string, string> | undefined {
  const path = envFileFor(id, envDir);
  if (!existsSync(path)) return undefined;
  return parseEnvFile(readFileSync(path, "utf8"));
}

function readProfilesJson(envDir: string): ProfilesJson {
  const path = join(dirname(envDir), "profiles.json");
  if (!existsSync(path)) return { version: 1, profiles: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === 1 &&
      Array.isArray((parsed as { profiles?: unknown }).profiles)
    ) {
      return parsed as ProfilesJson;
    }
  } catch {
    // Falls through to the empty registry below — a corrupt profiles.json
    // shouldn't take down `GET /control/profiles` for every profile.
  }
  return { version: 1, profiles: [] };
}

/** Absolute path, `~` expanded, trailing slash stripped — so the same real
 * `$HOME` written two different ways in two `.env` files still compares
 * equal. Absence of `RELAY_HOME_OVERRIDE` means the real `$HOME`, which is a
 * concrete value for this comparison, not "no override to compare". */
function normalizeHomeOverride(homeOverride: string | undefined): string {
  if (!homeOverride) return resolve(homedir());
  const expanded = homeOverride.startsWith("~") ? join(homedir(), homeOverride.slice(1)) : homeOverride;
  return resolve(expanded);
}

export function findHomeOverrideCollision(homeOverride: string | undefined, envDir: string = ENV_DIR): string | undefined {
  const target = normalizeHomeOverride(homeOverride);
  for (const id of listEnvIds(envDir)) {
    const env = readEnvFile(id, envDir);
    if (!env) continue;
    if (normalizeHomeOverride(env.RELAY_HOME_OVERRIDE) === target) return id;
  }
  return undefined;
}

/** Called once at boot (server.ts) so a relay started the plain `npm start`
 * way — no `add-profile.sh`, no `<id>.env` at all, just `RELAY_PORT`/
 * `RELAY_HOST` off the process env or their defaults — still shows up in its
 * own control API under id `"default"`, the same id the client always seeds
 * (client/src/lib/profiles.ts). Without this, `listEnvIds` never contains
 * this instance and `PATCH /control/profiles/default` 404s on every
 * fresh single-profile install.
 *
 * Two guards keep this from ever touching an already-provisioned setup:
 * skip if this exact port is already claimed by some other `<id>.env`
 * (this instance already has a real identity — writing `default.env` too
 * would double-list the same host:port), and skip if `default.env` already
 * exists (never clobber a prior self-registration or a deliberately
 * `add-profile.sh`-created "default" profile). */
export function ensureSelfRegistered(
  config: { port: number; host: string; homeOverride?: string },
  envDir: string = ENV_DIR,
): void {
  const portClaimed = listEnvIds(envDir).some((id) => Number(readEnvFile(id, envDir)?.RELAY_PORT) === config.port);
  if (portClaimed) return;

  const path = envFileFor("default", envDir);
  if (existsSync(path)) return;

  mkdirSync(envDir, { recursive: true });
  const lines = [`RELAY_PORT=${config.port}`, `RELAY_HOST=${config.host}`];
  if (config.homeOverride) lines.push(`RELAY_HOME_OVERRIDE=${config.homeOverride}`);
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port, timeout: 300 });
    const finish = (open: boolean) => {
      socket.destroy();
      resolveProbe(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** `GET /control/profiles` — a profile that exists as a `.env` file but
 * isn't in `profiles.json` yet (true of every profile until the first
 * create/edit through this registry) is still valid: label falls back to
 * `id`, `colorIndex` to position in the list. */
export async function listProfiles(envDir: string = ENV_DIR): Promise<HostProfile[]> {
  const ids = listEnvIds(envDir);
  const metaById = new Map(readProfilesJson(envDir).profiles.map((meta) => [meta.id, meta]));

  return Promise.all(
    ids.flatMap((id, index) => {
      const env = readEnvFile(id, envDir);
      if (!env?.RELAY_PORT) return [];
      const port = Number(env.RELAY_PORT);
      if (!Number.isFinite(port)) return [];
      const host = env.RELAY_HOST ?? "127.0.0.1";
      const meta = metaById.get(id);
      return isPortOpen(host, port).then((running) => ({
        id,
        label: meta?.label ?? id,
        colorIndex: meta?.colorIndex ?? index,
        host,
        port,
        hasHomeOverride: Boolean(env.RELAY_HOME_OVERRIDE),
        running,
        ...(meta?.themeId ? { themeId: meta.themeId } : {}),
      }));
    }),
  );
}

const PORT_RANGE_START = 8765;
const PORT_RANGE_END = 8865;

function canBind(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const server = createServer();
    server.once("error", () => resolveProbe(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveProbe(true)));
  });
}

/** Scans existing `.env` files *and* test-binds the candidate — scanning
 * alone would keep handing out the port of a profile that's just stopped
 * right now; binding alone would re-hand-out the port of a profile that's
 * merely stopped at the moment). */
export async function allocatePort(envDir: string = ENV_DIR): Promise<number> {
  const claimed = new Set(
    listEnvIds(envDir)
      .map((id) => Number(readEnvFile(id, envDir)?.RELAY_PORT))
      .filter((port) => Number.isFinite(port)),
  );
  for (let port = PORT_RANGE_START; port < PORT_RANGE_END; port++) {
    if (claimed.has(port)) continue;
    if (await canBind(port)) return port;
  }
  throw new Error(`no free relay port available in ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

function writeProfilesJson(envDir: string, data: ProfilesJson): void {
  const path = join(dirname(envDir), "profiles.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** `PATCH /control/profiles/:id` — `id` is immutable (see `Profile.id` on
 * the client), only `label`/`colorIndex`/`themeId` move. Works even for a
 * profile that predates `profiles.json` (fills in the other fields from
 * their current fallback — id as label, position in the list as colorIndex
 * — instead of leaving them unset). Throws if `id` isn't a real profile,
 * since there'd be nothing to attach the metadata to.
 *
 * `themeId: null` clears the selection back to the built-in theme —
 * distinct from omitting the field, which leaves whatever is stored alone,
 * the same way the other two behave. */
export function updateProfileMeta(
  id: string,
  patch: { label?: string; colorIndex?: number; themeId?: string | null },
  envDir: string = ENV_DIR,
): ProfileMeta {
  const ids = listEnvIds(envDir);
  const position = ids.indexOf(id);
  if (position === -1) {
    throw new Error(`profile '${id}' not found`);
  }

  const current = readProfilesJson(envDir);
  const existing = current.profiles.find((meta) => meta.id === id);
  const now = new Date().toISOString();
  const themeId = patch.themeId === null ? undefined : (patch.themeId ?? existing?.themeId);
  const merged: ProfileMeta = {
    id,
    label: patch.label ?? existing?.label ?? id,
    colorIndex: patch.colorIndex ?? existing?.colorIndex ?? position,
    ...(themeId ? { themeId } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  writeProfilesJson(envDir, { version: 1, profiles: [...current.profiles.filter((meta) => meta.id !== id), merged] });
  return merged;
}

/** `DELETE /control/profiles/:id` — removes the `.env` and the
 * `profiles.json` entry only. Deliberately never touches the profile's
 * `$HOME` or its `RELAY_SESSIONS_FILE`/transcripts: those are the actual
 * Claude account and conversation history, teardown undoes provisioning,
 * not the account. Stopping/disabling the systemd instance is the
 * caller's job (`server.ts`), since that's a process concern, not a
 * registry one. */
export function deleteProfileFiles(id: string, envDir: string = ENV_DIR): void {
  const envPath = envFileFor(id, envDir);
  if (existsSync(envPath)) rmSync(envPath);

  const current = readProfilesJson(envDir);
  if (current.profiles.some((meta) => meta.id === id)) {
    writeProfilesJson(envDir, { version: 1, profiles: current.profiles.filter((meta) => meta.id !== id) });
  }
}

