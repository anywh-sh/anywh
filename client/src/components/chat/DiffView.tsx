import { CodeLines, type CodeLine } from "@/components/chat/CodeLines";
import type { StructuredPatchHunk } from "@/lib/relay/relay-types";

interface DiffViewProps {
  hunks: StructuredPatchHunk[];
  language: string;
}

function kindForMarker(marker: string): CodeLine["kind"] {
  if (marker === "+") return "add";
  if (marker === "-") return "del";
  return "context";
}

/** The relay already delivers the diff ready-made (`outcome.diff`) — this
 * just flattens the hunks into a list of lines, each hunk under its `@@`
 * header, and delegates per-line color + language highlighting + truncation
 * to `CodeLines`. */
export function DiffView({ hunks, language }: DiffViewProps) {
  const lines: CodeLine[] = [];
  hunks.forEach((hunk) => {
    lines.push({ kind: "hunk", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
    for (const line of hunk.lines) {
      lines.push({ kind: kindForMarker(line.charAt(0)), text: line.slice(1) });
    }
  });

  return <CodeLines language={language} lines={lines} />;
}
