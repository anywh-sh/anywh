// The few `oauthAccount` keys of a profile's `.claude.json` that plan usage
// needs (journal/99 §3A, §12.3): the rate limit tiers that turn "Max" into
// "Max 5x"/"Max 20x", and the account/organization UUIDs behind the
// account key.
//
// The file is undocumented, rewritten by Claude Code all the time, and sits
// next to a login: it is read by key — never iterated, never serialized,
// never logged — and anything off (missing, half-written, unknown shape)
// falls back to "no tier, no file identity" instead of failing the read.
//
// Path: `${CLAUDE_CONFIG_DIR:-<home>}/.claude.json`, where `<home>` is the
// profile's effective home (`RELAY_HOME_OVERRIDE`, else `$HOME`) — the same
// rule as agentWorker.ts. A symlinked file (the `trabalho` profile's points
// into another dir) is followed; the cache is keyed by the unresolved path.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeFileIdentity } from "./accountKey.js";
import { isRecord } from "./windows.js";

export interface ClaudeTiers {
  userRateLimitTier: string | null;
  organizationRateLimitTier: string | null;
  seatTier: string | null;
  organizationType: string | null;
}

export interface ClaudeAccountFile {
  tiers: ClaudeTiers;
  /** Relay-internal: feed to `claudeAccountKey`, never send or log. */
  identity: ClaudeFileIdentity;
}

export interface ReadClaudeAccountFileOptions {
  env?: NodeJS.ProcessEnv;
  /** Wait before the one retry of a file that didn't parse. */
  retryDelayMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 50;

export function claudeAccountFilePath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || home, ".claude.json");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Pure extraction from the parsed file, by key. Undefined without an
 * `oauthAccount` object. */
export function extractClaudeAccount(parsed: unknown): ClaudeAccountFile | undefined {
  if (!isRecord(parsed) || !isRecord(parsed.oauthAccount)) return undefined;
  const account = parsed.oauthAccount;
  return {
    tiers: {
      userRateLimitTier: stringOrNull(account.userRateLimitTier),
      organizationRateLimitTier: stringOrNull(account.organizationRateLimitTier),
      seatTier: stringOrNull(account.seatTier),
      organizationType: stringOrNull(account.organizationType),
    },
    identity: {
      accountUuid: stringOrNull(account.accountUuid),
      organizationUuid: stringOrNull(account.organizationUuid),
    },
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readOnce(path: string): Promise<{ parsed: unknown } | "missing" | "unparsable"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return "missing";
  }
  try {
    return { parsed: JSON.parse(text) as unknown };
  } catch {
    return "unparsable";
  }
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  value: ClaudeAccountFile | undefined;
}

/**
 * Reads a profile's `.claude.json`. Undefined when the file is missing,
 * has no `oauthAccount`, or still doesn't parse after one short retry (Claude
 * Code was mid-write). Never rejects. Unchanged files (same mtime and size)
 * are answered from a cache keyed by the unresolved path.
 */
export function createClaudeAccountFileReader(): (home: string, options?: ReadClaudeAccountFileOptions) => Promise<ClaudeAccountFile | undefined> {
  const cache = new Map<string, CacheEntry>();
  return async (home, options = {}) => {
    const path = claudeAccountFilePath(home, options.env);
    let info;
    try {
      info = await stat(path);
    } catch {
      cache.delete(path);
      return undefined;
    }
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value;

    let result = await readOnce(path);
    if (result === "unparsable") {
      await delay(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
      result = await readOnce(path);
    }
    if (typeof result === "string") {
      // Not cached: a half-written file is retried on the next read.
      cache.delete(path);
      return undefined;
    }
    const value = extractClaudeAccount(result.parsed);
    cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, value });
    return value;
  };
}
