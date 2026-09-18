import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Extracts the `description:` field from a Markdown file's YAML
 * frontmatter (`---\n...\n---` at the very top). Deliberately not a real
 * YAML parser — every skill/subagent file in practice writes this as one
 * `key: value` line (quoted or not), never nested structure, so pulling in
 * a YAML dependency for this single field isn't worth it. Returns "" (not
 * undefined) for "no frontmatter" and "no such field" alike: the caller
 * tokenizes this string either way, and both cases cost 0 tokens the same
 * as a real, empty description would.
 */
export function readFrontmatterDescription(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  if (end === -1) return "";
  const match = /^description:\s*(.*)$/m.exec(text.slice(3, end));
  if (!match) return "";
  const raw = match[1].trim();
  const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
  return quoted ? quoted[1] : raw;
}

/**
 * Lists the description-bearing files under `dir`, in one of two real
 * on-disk shapes: `"skill-folders"` (`<dir>/<name>/SKILL.md`, Claude and
 * Codex's skill convention) or `"flat-md"` (`<dir>/<name>.md`, Claude's
 * subagent convention). An unreadable or missing `dir` degrades to an empty
 * list — same "not measured, not present" shape every other cwd-optional
 * read in this feature already uses, not a special case.
 */
export function listAssetFiles(dir: string, shape: "skill-folders" | "flat-md"): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  if (shape === "flat-md") {
    return entries.filter((entry) => entry.endsWith(".md")).map((entry) => join(dir, entry));
  }
  const out: string[] = [];
  for (const entry of entries) {
    const skillFile = join(dir, entry, "SKILL.md");
    try {
      if (statSync(skillFile).isFile()) out.push(skillFile);
    } catch {
      // Not a skill folder (no SKILL.md inside) — ignore, same as any other
      // stray entry a real user's config directory accumulates over time.
    }
  }
  return out;
}

/** Every file this asset type can live under, across both roots a session
 * knows about (its own `cwd` for a project-level asset, and the agent's
 * home directory for a user-level one) and every relative dir the def
 * declares (Codex's skills split across `.codex/skills`/`.agents/skills`). */
export function listAssetFilesAcross(roots: readonly string[], relDirs: readonly string[], shape: "skill-folders" | "flat-md"): string[] {
  const out: string[] = [];
  for (const root of roots) {
    for (const relDir of relDirs) {
      out.push(...listAssetFiles(join(root, relDir), shape));
    }
  }
  return out;
}
