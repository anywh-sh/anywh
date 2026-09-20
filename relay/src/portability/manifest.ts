// What "the user's setup" is, as data — the wire shape shared by the three
// things a config home can be asked: what have you got, hand it over, take
// this. Pure: nothing here touches the filesystem (that's configHome.ts) or
// parses a declaration file (declaration.ts).
//
// A manifest, not an archive. Files are the parts a runtime's config home
// holds that are entirely the user's work; the MCP servers ride along as a
// *declaration* (names and their settings), never as the credentials that
// authenticate them — those are re-earned on the destination machine, by
// the user, exactly as they were the first time.

import { isAbsolute, normalize } from "node:path";

/** One file under the runtime's config home, addressed the way the def
 * declares its paths: relative to that home, so the same manifest applies
 * to a home at a different absolute path. */
export interface PortableFile {
  readonly path: string;
  /** Base64. A skill folder is not only Markdown — it can carry a helper
   * script, a reference PDF, an image — and a UTF-8 round trip would
   * quietly corrupt any of them. */
  readonly contents: string;
  readonly bytes: number;
  /** Preserved for one reason: a skill's helper script that arrives
   * without its executable bit is a skill that fails the first time it
   * runs, in a way that looks like the skill is broken. */
  readonly executable: boolean;
}

/** The portable slice of the file where a runtime declares its MCP
 * servers. Carried as parsed values rather than as the file's text,
 * because the destination's copy of that file has its own content to keep:
 * applying this merges these keys in, it never overwrites the file. */
export interface PortableDeclaration {
  readonly path: string;
  readonly format: "json" | "toml";
  readonly values: Readonly<Record<string, unknown>>;
}

/** Why a file that copies cleanly may still not *work* on the destination.
 * A code and its operands, never a sentence: this crosses into the UI, and
 * UI text lives in the dictionary (`client/src/i18n/`), not here. */
export interface PortabilityWarning {
  readonly kind: "absolute-path" | "file-too-large" | "bundle-truncated";
  /** The file the warning is about, relative to the config home. */
  readonly path: string;
  /** The offending value for `absolute-path`, a byte count rendered as
   * text for the two size warnings. */
  readonly detail: string;
}

export interface PortabilityBundle {
  readonly runtimeId: string;
  readonly files: readonly PortableFile[];
  readonly declaration?: PortableDeclaration;
  /** Names only. Enough for the UI to say "these three servers come with
   * it, and you'll be asked to sign in to them there", which is the whole
   * honest story: the servers are declared, the sessions are not. */
  readonly mcpServers: readonly string[];
  readonly warnings: readonly PortabilityWarning[];
}

/** What the UI asks before it offers the checkbox at all — the same
 * bundle with the file contents left out, so "do I have anything to
 * carry?" doesn't transfer megabytes to answer. */
export type PortabilitySnapshot = Omit<PortabilityBundle, "files"> & {
  readonly files: readonly { readonly path: string; readonly bytes: number }[];
  readonly found: boolean;
};

/** The half of a bundle that `applyBundle` actually writes — narrower than
 * `PortabilityBundle` on purpose, so the guard that validates one arriving
 * over HTTP only has to prove the fields that get used. `bytes` and
 * `warnings` are for the UI to read; nothing on the writing side needs
 * them. */
export interface ApplicableBundle {
  readonly files: readonly Pick<PortableFile, "path" | "contents" | "executable">[];
  readonly declaration?: PortableDeclaration;
}

export function toSnapshot(bundle: PortabilityBundle): PortabilitySnapshot {
  const { files, ...rest } = bundle;
  return {
    ...rest,
    files: files.map((file) => ({ path: file.path, bytes: file.bytes })),
    // A declaration alone is worth carrying even with no authored file
    // next to it — someone whose whole setup is three MCP servers has a
    // setup.
    found: files.length > 0 || rest.declaration !== undefined,
  };
}

/** Rejects a manifest path that would write outside the config home it is
 * applied to. The def's own paths are already checked at boot
 * (`assertCoherent`), but a manifest arrives over HTTP from another
 * machine's relay, and "the other end is also ours" is an assumption, not
 * a guarantee. */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) return false;
  const segments = normalize(path).split(/[\\/]/);
  return !segments.includes("..") && segments.every((segment) => segment !== "");
}

// Matches a posix absolute path or a Windows drive path appearing anywhere
// in a string. Deliberately loose: this feeds a warning a human reads, not
// a decision the code makes on its own.
const ABSOLUTE_PATH_HINT = /(^|[\s"'=:,[(])((\/[A-Za-z0-9._-]+){2,}|[A-Za-z]:\\[^\s"']+)/;

/**
 * Finds settings that name a place rather than a thing — a hook pointing
 * at `/home/someone/bin/lint`, an MCP server spawned from
 * `/Users/someone/.nvm/...`. They copy across perfectly and then fail on
 * first use, because the destination has no such path.
 *
 * Deliberately a warning, never a filter: the user may be copying onto a
 * machine where that path genuinely exists, and silently dropping half
 * their hooks would be far worse than telling them which ones look
 * suspect. Recurses through objects and arrays so a hook buried three
 * levels down is still seen.
 */
export function findAbsolutePathValues(value: unknown, path: string): PortabilityWarning[] {
  const warnings: PortabilityWarning[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (ABSOLUTE_PATH_HINT.test(node)) warnings.push({ kind: "absolute-path", path, detail: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const entry of Object.values(node)) visit(entry);
    }
  };
  visit(value);
  return warnings;
}
