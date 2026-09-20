import { chmodSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import { listDeclaredServers, mergeDeclaration, parseDeclaration, pickPortableKeys } from "./declaration.js";
import { findAbsolutePathValues, isSafeRelativePath, type ApplicableBundle, type PortabilityBundle, type PortabilityWarning, type PortableFile } from "./manifest.js";
import type { AgentRuntimeDef } from "../runtimes/types.js";

// Reads and writes one runtime's config home — the plumbing half of
// carrying a setup somewhere else. The def says *which* paths matter
// (`portability`); this file is the only place that resolves them against a
// real directory.
//
// Deliberately not an extension of `/files/*`: those routes are rooted at
// the session's cwd (`resolveWithinRoot`) and cannot reach `~/.claude` or
// `~/.codex` at all. Deliberately not a tarball either — see manifest.ts.

/** Per file. A skill folder holding a 40 MB sample dataset is a real
 * possibility, and base64 in a JSON body is the wrong way to move it. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Per bundle. Two orders of magnitude above a realistic setup (the
 * measuring machine's whole Claude config home, skills included, was under
 * 300 KB), and still small enough that a runaway directory becomes a
 * warning instead of a relay that stalls serializing base64. */
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

/** Manifest paths are posix-shaped on the wire so a bundle read on Linux
 * applies on Windows and back. */
function toManifestPath(relativePath: string): string {
  return relativePath.split(sep).join(posix.sep);
}

function fromManifestPath(manifestPath: string): string {
  return manifestPath.split(posix.sep).join(sep);
}

interface WalkState {
  readonly files: PortableFile[];
  readonly warnings: PortabilityWarning[];
  totalBytes: number;
}

/** Depth-first, symlinks never followed: a link inside a skill folder
 * pointing at `~/.ssh` would otherwise be read and shipped as if the user
 * had authored it. `lstatSync` is what makes that a skip rather than a
 * silent read-through. */
function walk(home: string, relativePath: string, state: WalkState): void {
  const absolute = join(home, relativePath);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    // Not there. A def lists the paths a runtime *can* use, so most homes
    // will be missing several of them, and that is the ordinary case, not
    // an error worth reporting.
    return;
  }
  if (stats.isSymbolicLink()) return;

  if (stats.isDirectory()) {
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      return;
    }
    for (const entry of entries.sort()) walk(home, join(relativePath, entry), state);
    return;
  }
  if (!stats.isFile()) return;

  const manifestPath = toManifestPath(relativePath);
  if (stats.size > MAX_FILE_BYTES) {
    state.warnings.push({ kind: "file-too-large", path: manifestPath, detail: String(stats.size) });
    return;
  }
  if (state.totalBytes + stats.size > MAX_BUNDLE_BYTES) {
    state.warnings.push({ kind: "bundle-truncated", path: manifestPath, detail: String(state.totalBytes) });
    return;
  }

  let contents: Buffer;
  try {
    contents = readFileSync(absolute);
  } catch {
    return;
  }
  state.totalBytes += stats.size;
  state.files.push({
    path: manifestPath,
    contents: contents.toString("base64"),
    bytes: stats.size,
    // Owner-execute is the bit that matters: a helper script beside a
    // SKILL.md is run by the agent, not by another user.
    executable: (stats.mode & constants.S_IXUSR) !== 0,
  });

  // Only JSON gets scanned for paths that won't exist on the destination.
  // It is where the two CLIs keep hooks and MCP spawn commands, and it is
  // parseable without guessing — running the same heuristic over arbitrary
  // Markdown would flag every skill that mentions a path in prose.
  if (manifestPath.endsWith(".json")) {
    try {
      state.warnings.push(...findAbsolutePathValues(JSON.parse(contents.toString("utf8")), manifestPath));
    } catch {
      // Unparseable JSON in the user's own config: not this feature's
      // problem to report, and not a reason to refuse to carry the file.
    }
  }
}

/**
 * Everything this runtime's config home has that is worth carrying: the
 * files the def calls the user's own, plus the allowlisted slice of its MCP
 * declaration.
 *
 * Never credentials. Both CLIs keep MCP tokens in a file this function
 * doesn't read, and one of them keeps the *account's* token in that same
 * file — which is precisely why "copy the config home" isn't what this
 * does.
 */
export function readBundle(def: AgentRuntimeDef, home: string): PortabilityBundle {
  const state: WalkState = { files: [], warnings: [], totalBytes: 0 };
  for (const authoredPath of def.portability.authoredPaths) {
    walk(home, fromManifestPath(authoredPath), state);
  }

  const { mcp } = def.portability;
  if (mcp.kind === "none") {
    return { runtimeId: def.identity.id, files: state.files, mcpServers: [], warnings: state.warnings };
  }

  const { declaration } = mcp;
  let declarationText = "";
  try {
    declarationText = readFileSync(join(home, fromManifestPath(declaration.path)), "utf8");
  } catch {
    // No declaration file yet — a runtime the user never added a server
    // to. Their authored files still travel.
  }
  const parsed = parseDeclaration(declarationText, declaration.format);
  const values = declaration.kind === "shared" ? pickPortableKeys(parsed, declaration.portableKeys) : parsed;
  const servers = listDeclaredServers(values, declaration.serversKey);
  const warnings = [...state.warnings, ...findAbsolutePathValues(values, declaration.path)];

  return {
    runtimeId: def.identity.id,
    files: state.files,
    // Absent rather than empty when there is nothing to declare, so
    // applying it writes no file at all.
    declaration: Object.keys(values).length > 0 ? { path: declaration.path, format: declaration.format, values } : undefined,
    mcpServers: servers,
    warnings,
  };
}

export interface ApplyResult {
  readonly written: readonly string[];
  /** Paths refused because they would have escaped the config home. Never
   * expected from a bundle this relay produced; a bundle arrives over HTTP
   * from another machine, so "never expected" is not "impossible". */
  readonly rejected: readonly string[];
}

/**
 * Writes a bundle into a config home.
 *
 * Files are written whole (a file that exists is replaced — an authored
 * path is the user's own by definition, and the offer that produced this
 * bundle is only made for a home with nothing there yet). The declaration
 * is the exception and is *merged*, because its file is shared with state
 * that belongs to the destination: machine identity, per-project trust,
 * whatever the local CLI wrote before anyone thought about carrying
 * anything.
 */
export function applyBundle(def: AgentRuntimeDef, home: string, bundle: ApplicableBundle): ApplyResult {
  const written: string[] = [];
  const rejected: string[] = [];

  for (const file of bundle.files) {
    if (!isSafeRelativePath(file.path)) {
      rejected.push(file.path);
      continue;
    }
    const absolute = join(home, fromManifestPath(file.path));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, Buffer.from(file.contents, "base64"));
    // 0o700/0o600 rather than a copy of the source's mode: this is the
    // user's own configuration on a machine they may share, and the only
    // bit of the original mode that changes behaviour is the executable
    // one.
    chmodSync(absolute, file.executable ? 0o700 : 0o600);
    written.push(file.path);
  }

  const { declaration } = bundle;
  if (declaration && def.portability.mcp.kind === "supported") {
    // The def, not the bundle, decides where this lands: a manifest from
    // another machine naming its own path is exactly the input that
    // shouldn't get to choose a write target.
    const target = def.portability.mcp.declaration;
    const absolute = join(home, fromManifestPath(target.path));
    let existing = "";
    try {
      existing = readFileSync(absolute, "utf8");
    } catch {
      // First write into a fresh home — the common case, since seeding is
      // only offered for one.
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, mergeDeclaration(existing, declaration.values, target.format));
    chmodSync(absolute, 0o600);
    written.push(target.path);
  }

  return { written, rejected };
}
