// Opaque account ids, so the client can tell that two profiles are logged in
// to the same Claude or Codex account without ever seeing who it is
// (journal/99 §12.3):
//
//   accountKey = hex(HMAC-SHA256(salt, [runtime, kind, part1, part2]))[0:16]
//
// - Claude: (accountUuid, organizationUuid) from `.claude.json`; fallback
//   (email, orgId) from `claude auth status`, which is the authority — when
//   its orgId disagrees with the file, the file is ignored.
// - Codex: (email, planType) from app-server `account/read`. `auth.json`
//   holds the only account id, inside a credential: it is never read.
//
// Any missing part → no key, which the client reads as "a distinct
// account": two accounts are never merged on a guess. The two Claude paths
// produce different keys for the same account (different inputs), so a
// profile on the fallback just doesn't deduplicate against one on the file.
//
// The salt is 32 random bytes shared by every relay on the machine — next to
// the profile env files, `~/.config/anywh/account-salt` (0600), never under a
// profile's home — since a per-relay salt would make keys from two profiles
// incomparable. It never leaves the relay.
//
// The parts (e-mails, UUIDs) are hashed here and dropped: nothing in this
// module returns or logs them.
import { createHmac, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENV_DIR } from "../host/profileRegistry.js";
import type { PlanUsageRuntime } from "./types.js";
import { isRecord } from "./windows.js";

export const ACCOUNT_KEY_HEX_LENGTH = 16;
export const ACCOUNT_SALT_BYTES = 32;
export const ACCOUNT_SALT_FILE = "account-salt";

/** `~/.config/anywh`, beside the `env/` dir — machine-wide, not per profile.
 * Follows `ANYWH_ENV_DIR`, so a test relocates it with the profiles. */
export const DEFAULT_ACCOUNT_SALT_DIR = dirname(ENV_DIR);

/** Which pair of parts a key was built from; part of the HMAC input, so a
 * pair can't collide with another kind's. */
export type AccountKeyKind = "claude_account_org" | "claude_email_org" | "codex_email_plan";

function normalizePart(part: unknown): string | null {
  if (typeof part !== "string") return null;
  const normalized = part.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

/** The key for one pair of parts, or undefined when either is missing. Parts
 * are trimmed and lowercased (e-mails and UUIDs are case-insensitive). */
export function deriveAccountKey(salt: Uint8Array, runtime: PlanUsageRuntime, kind: AccountKeyKind, part1: unknown, part2: unknown): string | undefined {
  const a = normalizePart(part1);
  const b = normalizePart(part2);
  if (a === null || b === null) return undefined;
  // JSON keeps the boundaries between parts unambiguous.
  const input = JSON.stringify([runtime, kind, a, b]);
  return createHmac("sha256", salt).update(input).digest("hex").slice(0, ACCOUNT_KEY_HEX_LENGTH);
}

/** The identity half of `.claude.json` (see `readClaudeAccountFile`). */
export interface ClaudeFileIdentity {
  accountUuid: string | null;
  organizationUuid: string | null;
}

/**
 * Claude's key. `authStatus` is the parsed `claude auth status --json`
 * (only `email`/`orgId` are read). The file identity is used when complete
 * and consistent with the status's `orgId`; otherwise the status's
 * (email, orgId).
 */
export function claudeAccountKey(salt: Uint8Array, file: ClaudeFileIdentity | undefined, authStatus: unknown): string | undefined {
  const status = isRecord(authStatus) ? authStatus : {};
  const statusOrg = normalizePart(status.orgId);
  const fileOrg = normalizePart(file?.organizationUuid);
  const fileAgrees = statusOrg === null || fileOrg === statusOrg;
  if (file && fileAgrees) {
    const key = deriveAccountKey(salt, "claude", "claude_account_org", file.accountUuid, file.organizationUuid);
    if (key) return key;
  }
  return deriveAccountKey(salt, "claude", "claude_email_org", status.email, status.orgId);
}

/** Codex's key, straight from `account/read`'s result: the e-mail is read
 * here and nowhere else, and only the hash comes out. Undefined when not a
 * ChatGPT login or a part is missing. */
export function codexAccountKey(salt: Uint8Array, accountReadResult: unknown): string | undefined {
  if (!isRecord(accountReadResult) || !isRecord(accountReadResult.account)) return undefined;
  const account = accountReadResult.account;
  if (account.type !== "chatgpt") return undefined;
  return deriveAccountKey(salt, "codex", "codex_email_plan", account.email, account.planType);
}

/** At most the first 4 hex of a key, for a log line. */
export function accountKeyForLog(key: string | undefined): string {
  return key ? `${key.slice(0, 4)}…` : "none";
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isTaken(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

async function readSalt(path: string): Promise<Uint8Array | undefined | "missing"> {
  try {
    const bytes = await readFile(path);
    return bytes.length === ACCOUNT_SALT_BYTES ? new Uint8Array(bytes) : undefined;
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

/**
 * The machine's account salt, created on first use. Two relays may start
 * together: each writes its candidate to a private temp file (`wx`) and
 * publishes it with `link`, which fails if the salt already exists — so the
 * file appears whole or not at all, and the loser reads the winner's.
 *
 * Resolves undefined when the existing file is unusable (wrong size): keys
 * are then off (no dedupe) rather than the file being replaced under
 * another relay that already uses it. I/O errors reject.
 */
export async function loadOrCreateAccountSalt(dir: string = DEFAULT_ACCOUNT_SALT_DIR): Promise<Uint8Array | undefined> {
  const path = join(dir, ACCOUNT_SALT_FILE);
  const existing = await readSalt(path);
  if (existing !== "missing") return existing;

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${ACCOUNT_SALT_FILE}.${process.pid}.${randomBytes(6).toString("hex")}`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(randomBytes(ACCOUNT_SALT_BYTES));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, path);
  } catch (error) {
    if (!isTaken(error)) throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  const salt = await readSalt(path);
  return salt === "missing" ? undefined : salt;
}
