import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { McpDeclarationFormat } from "../runtimes/types.js";

// Reading named keys out of one machine's declaration file and writing them
// into another's. Pure text in, text out — the filesystem lives in
// configHome.ts.
//
// Why a real parser for TOML instead of the line-slicing this file's first
// sketch used: the two operations here are the only ones in this feature
// that can *destroy* something the user wrote. A destination's config file
// is theirs, with their own keys in it, and a merge that mishandles an
// inline table or a multi-line string doesn't fail loudly — it writes a
// file the CLI then rejects, or worse, silently reads differently.
// `smol-toml` is the one dependency this feature adds for that reason.

/** Parsed contents of a declaration file. `{}` for a file that isn't there
 * yet or can't be parsed — reading a broken config is "nothing to carry",
 * never a crash on the caller. */
export function parseDeclaration(text: string, format: McpDeclarationFormat): Record<string, unknown> {
  try {
    const parsed: unknown = format === "json" ? JSON.parse(text) : parseToml(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The allowlisted slice of a declaration file, with absent keys simply
 * absent — never `undefined` values, which JSON would drop and TOML
 * couldn't render at all. */
export function pickPortableKeys(values: Record<string, unknown>, portableKeys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of portableKeys) {
    if (Object.hasOwn(values, key)) picked[key] = values[key];
  }
  return picked;
}

/**
 * Merges `incoming` into `existingText`, key by key, and returns the file
 * to write.
 *
 * Top-level keys only, and replacing rather than deep-merging, because that
 * is what the contract's `portableKeys` names: `mcp_servers` is one key
 * whose value is the whole server table. Deep-merging it would keep a
 * server the destination had under a name the source also uses, half from
 * each — a configuration neither machine ever had.
 *
 * Everything the destination holds outside those keys survives untouched
 * in value. Formatting and comments do not: both formats are rewritten
 * from their parsed form, which is what makes the merge trustworthy in the
 * first place.
 */
export function mergeDeclaration(existingText: string, incoming: Record<string, unknown>, format: McpDeclarationFormat): string {
  const merged = { ...parseDeclaration(existingText, format), ...incoming };
  if (format === "json") return `${JSON.stringify(merged, null, 2)}\n`;
  return stringifyToml(merged).endsWith("\n") ? stringifyToml(merged) : `${stringifyToml(merged)}\n`;
}

/** The names under the def's own `serversKey`. A value shaped like
 * anything but an object keyed by name reports no servers rather than
 * guessing at what a future CLI version meant. */
export function listDeclaredServers(values: Record<string, unknown>, serversKey: string): string[] {
  const servers = values[serversKey];
  return typeof servers === "object" && servers !== null && !Array.isArray(servers) ? Object.keys(servers) : [];
}
