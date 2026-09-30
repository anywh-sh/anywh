import type { StructuredPatchHunk, ToolInput, ToolKind, ToolOutcome, ToolSubject } from "../../protocol/agent-event.js";

/**
 * Claude-specific interpretation of a tool call: which `ToolKind` it is, what
 * it is doing (`ToolSubject`) and how its result reads (`ToolOutcome`). Pure
 * and total — an input or result shape it doesn't recognize yields
 * `undefined`/`{ kind: "text" }`, never a throw, so a CLI update degrades a
 * call to the generic rendering instead of breaking the turn.
 *
 * Result shapes below were measured against real `tool_use_result` payloads
 * (transcripts on disk and a live `claude -p --output-format stream-json`
 * run for Glob/Grep, which don't show up in ordinary transcripts).
 */

const MCP_PREFIX = "mcp__";

// Logged once per name, not per occurrence — a tool called repeatedly in a
// long session shouldn't spam stderr, but a genuinely new/unrecognized name
// (a CLI update) is worth knowing about at least once.
const loggedUnknownTools = new Set<string>();

export function classifyToolKind(name: string): ToolKind {
  if (name.startsWith(MCP_PREFIX)) return "mcp";
  switch (name) {
    case "Bash":
      return "shell";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Write":
      return "write";
    case "Read":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
    case "WebSearch":
    case "WebFetch":
      return "web";
    case "Task":
      return "task";
    default:
      if (!loggedUnknownTools.has(name)) {
        loggedUnknownTools.add(name);
        console.error(`[relay] unrecognized tool name "${name}", mapping to ToolKind "other"`);
      }
      return "other";
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `mcp__<server>__<tool>` — the tool part may itself contain `__`, the
 * server part never does. */
export function parseMcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined;
  const rest = name.slice(MCP_PREFIX.length);
  const split = rest.indexOf("__");
  if (split <= 0) return undefined;
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

export function deriveSubject(name: string, input: ToolInput): ToolSubject | undefined {
  const mcp = parseMcpName(name);
  if (mcp) return { kind: "mcp", ...mcp };

  switch (name) {
    case "Bash": {
      const command = str(input.command);
      return command ? { kind: "shell", command } : undefined;
    }
    case "Read": {
      const path = str(input.file_path);
      if (!path) return undefined;
      const offset = num(input.offset);
      const limit = num(input.limit);
      if (offset === undefined && limit === undefined) return { kind: "read", path };
      const start = offset ?? 1;
      return { kind: "read", path, range: { start, ...(limit !== undefined ? { end: start + limit - 1 } : {}) } };
    }
    case "Edit":
    case "MultiEdit":
    case "Write": {
      const path = str(input.file_path);
      return path ? { kind: name === "Write" ? "write" : "edit", path } : undefined;
    }
    case "NotebookEdit": {
      const path = str(input.notebook_path);
      return path ? { kind: "edit", path } : undefined;
    }
    case "Grep": {
      const pattern = str(input.pattern);
      const path = str(input.path);
      return pattern ? { kind: "search", mode: "content", pattern, ...(path ? { path } : {}) } : undefined;
    }
    case "Glob": {
      const pattern = str(input.pattern);
      const path = str(input.path);
      return pattern ? { kind: "search", mode: "files", pattern, ...(path ? { path } : {}) } : undefined;
    }
    case "WebSearch": {
      const query = str(input.query);
      return query ? { kind: "web", mode: "search", query } : undefined;
    }
    case "WebFetch": {
      const url = str(input.url);
      return url ? { kind: "web", mode: "fetch", url } : undefined;
    }
    case "Task":
      return { kind: "task", label: str(input.description) ?? str(input.subagent_type) ?? name };
    default:
      return { kind: "other", label: name };
  }
}

/** What a paired `tool_use` contributes to interpreting its result. */
export interface ToolCallMemo {
  name: string;
  input: ToolInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countPatch(hunks: StructuredPatchHunk[]): { added: number; removed: number } {
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

function isPatchHunk(value: unknown): value is StructuredPatchHunk {
  return isRecord(value) && Array.isArray(value.lines) && num(value.oldStart) !== undefined && num(value.newStart) !== undefined;
}

/** A new file has no patch from the CLI — one all-added hunk of its content
 * stands in, so a diff renderer needs no special case for creation. */
function creationHunk(content: string): StructuredPatchHunk {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((line) => `+${line}`) };
}

/** `Grep` in content mode prints `path:line:text` (or `path-line-text` for
 * context lines, or bare `text` for a single-file search with no path). */
function parseGrepContent(content: string): { path: string; line?: number; text: string }[] {
  const matches: { path: string; line?: number; text: string }[] = [];
  for (const raw of content.split("\n")) {
    if (raw === "" || raw === "--") continue;
    const found = /^(.+?):(\d+):(.*)$/.exec(raw);
    if (found) matches.push({ path: found[1], line: Number(found[2]), text: found[3] });
    else matches.push({ path: "", text: raw });
  }
  return matches;
}

/** Claude reports a failed Bash call only as text: `Exit code N` on the
 * first line of the error content. Absent otherwise — never guessed. */
function bashExitCode(content: string, isError: boolean): number | undefined {
  if (!isError) return undefined;
  const found = /^Exit code (\d+)/.exec(content);
  return found ? Number(found[1]) : undefined;
}

function serializeRequest(input: ToolInput): string {
  return JSON.stringify(input, null, 2);
}

/**
 * `result` is the event's raw `tool_use_result`; `content` the flattened
 * plain-text result. `memo` (the paired `tool_use`) is optional: it only
 * refines what the result shape already says (an MCP call's request, a
 * Write's path) and is absent for an orphan result, which still gets the best
 * outcome the shape alone allows.
 */
export function deriveOutcome(result: unknown, content: string, isError: boolean, memo?: ToolCallMemo): ToolOutcome | undefined {
  // MCP calls report their result as the content-block array itself.
  if (Array.isArray(result)) {
    if (memo && parseMcpName(memo.name)) return { kind: "payload", request: serializeRequest(memo.input), response: content };
    return undefined;
  }
  if (!isRecord(result)) {
    if (memo && parseMcpName(memo.name)) return { kind: "payload", request: serializeRequest(memo.input), response: content };
    // A failed Bash call can report its `tool_use_result` as a bare error string.
    if (memo?.name === "Bash") {
      const exitCode = bashExitCode(content, isError);
      return { kind: "terminal", output: content, ...(exitCode !== undefined ? { exitCode } : {}) };
    }
    return undefined;
  }

  const file = result.file;
  const filePath = isRecord(file) ? str(file.filePath) : undefined;
  if (isRecord(file) && typeof file.content === "string" && filePath) {
    const startLine = num(file.startLine);
    const totalLines = num(file.totalLines);
    const lines = file.content.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return {
      kind: "code",
      path: filePath,
      lines,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(totalLines !== undefined ? { totalLines } : {}),
    };
  }

  const path = str(result.filePath) ?? str(memo?.input.file_path) ?? str(memo?.input.notebook_path);
  if (path && Array.isArray(result.structuredPatch)) {
    const hunks = result.structuredPatch.filter(isPatchHunk);
    const created = result.type === "create" || (memo?.name === "Write" && result.originalFile === null);
    if (created && hunks.length === 0 && typeof result.content === "string") {
      const hunk = creationHunk(result.content);
      return { kind: "diff", path, hunks: [hunk], added: hunk.newLines, removed: 0, created: true };
    }
    return { kind: "diff", path, hunks, ...countPatch(hunks), ...(created ? { created: true } : {}) };
  }

  if (typeof result.stdout === "string") {
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const output = stderr ? (result.stdout ? `${result.stdout}\n${stderr}` : stderr) : result.stdout;
    const exitCode = bashExitCode(content, isError);
    return { kind: "terminal", output, ...(exitCode !== undefined ? { exitCode } : {}) };
  }

  if (Array.isArray(result.results)) {
    const links: { title: string; url: string }[] = [];
    for (const group of result.results) {
      if (!isRecord(group) || !Array.isArray(group.content)) continue;
      for (const item of group.content) {
        const url = isRecord(item) ? str(item.url) : undefined;
        if (isRecord(item) && url) links.push({ title: str(item.title) ?? url, url });
      }
    }
    return links.length > 0 ? { kind: "links", results: links } : undefined;
  }

  if (Array.isArray(result.filenames)) {
    if (result.mode === "content" && typeof result.content === "string") {
      const matches = parseGrepContent(result.content);
      const total = num(result.totalLines) ?? num(result.numLines);
      return { kind: "matches", matches, ...(total !== undefined ? { total } : {}) };
    }
    const paths = result.filenames.filter((p): p is string => typeof p === "string");
    const total = num(result.totalFiles) ?? num(result.numFiles);
    return { kind: "files", paths, ...(total !== undefined ? { total } : {}) };
  }

  return undefined;
}
