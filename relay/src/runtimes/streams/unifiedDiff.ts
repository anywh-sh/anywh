import type { StructuredPatchHunk } from "../../protocol/agent-event.js";

/**
 * Parses a unified diff (`@@ -a,b +c,d @@` hunks) into the hunk shape the
 * Claude CLI already reports for an edit, so one diff renderer serves every
 * runtime. File headers (`diff --git`, `---`, `+++`, `index`) before or
 * between hunks are skipped, as is the `\ No newline at end of file` marker;
 * text that isn't a diff at all yields no hunks rather than a throw.
 */
export function parseUnifiedDiff(diff: string): StructuredPatchHunk[] {
  const hunks: StructuredPatchHunk[] = [];
  let current: StructuredPatchHunk | undefined;
  let oldSeen = 0;

  for (const raw of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] !== undefined ? Number(header[2]) : 1,
        newStart: Number(header[3]),
        newLines: header[4] !== undefined ? Number(header[4]) : 1,
        lines: [],
      };
      hunks.push(current);
      oldSeen = 0;
      continue;
    }
    if (!current) continue;
    const marker = raw[0];
    if (marker === " " || marker === "-") {
      current.lines.push(raw);
      oldSeen += 1;
    } else if (marker === "+") {
      current.lines.push(raw);
    } else if (raw === "" && oldSeen < current.oldLines) {
      // Some producers strip the single space of a blank context line; the
      // hunk header's own line count says whether one is still owed.
      current.lines.push(" ");
      oldSeen += 1;
    }
  }
  return hunks;
}
