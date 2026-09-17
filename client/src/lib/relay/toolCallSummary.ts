import type { StructuredPatchHunk } from "@/lib/relay/relay-types";

/**
 * The path a tool call shows in its header, trimmed of the session's working
 * directory — the design puts the file on the card's top line, and an
 * absolute path from the relay's machine (`/home/someone/projects/app/src/
 * components/Thing.tsx`) is mostly prefix nobody is reading. What's left is
 * what the user would type themselves.
 *
 * Separator-agnostic on purpose: `cwd` is the *relay's* working directory,
 * so a Windows relay reports backslashes to a client that may be running
 * anywhere. A path that doesn't sit under `cwd` is returned untouched rather
 * than mangled — better a long path than a wrong short one.
 */
export function relativeToCwd(path: string, cwd: string | null): string {
  if (!cwd) return path;
  const base = cwd.replace(/[/\\]+$/, "");
  if (!base || !path.startsWith(base)) return path;
  const rest = path.slice(base.length);
  // Guards against `/home/a/project` matching `/home/a/project-old`: the
  // next character has to be a real separator, not just more name.
  if (!rest.startsWith("/") && !rest.startsWith("\\")) return path;
  return rest.slice(1);
}

export interface DiffLineCounts {
  added: number;
  removed: number;
}

/**
 * Added/removed line counts for the header, from the diff the relay already
 * delivers ready-made. Counts the markers the patch format itself carries,
 * so a context line that happens to begin with a `+` in the source is never
 * counted — it arrives as `" +something"`, with the format's leading space.
 */
export function countDiffLines(hunks: StructuredPatchHunk[]): DiffLineCounts {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}
