import type { StructuredPatchHunk, ToolOutcome, ToolSubject } from "../../protocol/agent-event.js";
import { parseUnifiedDiff } from "./unifiedDiff.js";

/**
 * Codex-specific interpretation of thread items into `ToolSubject`/
 * `ToolOutcome`. Pure and total, like `claudeToolMapping.ts`. Field names
 * follow the bindings `codex app-server generate-ts --experimental` emits.
 *
 * The one Codex-specific wrinkle: Codex has no read/search tools — the model
 * runs shell commands — but the app-server classifies each command into
 * `commandActions` (`read`, `listFiles`, `search`). A command with exactly one
 * such action is shown as the read/search it really is; anything else (a
 * pipe, an unknown command) stays a shell call.
 */

export type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export interface FileChange {
  path: string;
  kind?: { type: "add" } | { type: "delete" } | { type: "update"; move_path?: string | null };
  diff: string;
}

/** Codex runs commands as `/usr/bin/bash -lc '<command>'`; the wrapper is
 * noise, the inner command is what the model asked for. */
export function unwrapShellCommand(command: string): string {
  const wrapped = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return wrapped?.[2] ?? command;
}

function singleAction(actions: unknown): CommandAction | undefined {
  if (!Array.isArray(actions) || actions.length !== 1) return undefined;
  const action = actions[0] as CommandAction | undefined;
  return action && typeof action === "object" && typeof action.type === "string" ? action : undefined;
}

/** `sed -n 2,3p file` reads lines 2–3: the only shell read whose range is
 * knowable from the command. */
function sedRange(command: string): { start: number; end: number } | undefined {
  const found = /\bsed\s+-n\s+'?(\d+),(\d+)p'?/.exec(command);
  return found ? { start: Number(found[1]), end: Number(found[2]) } : undefined;
}

export function commandSubject(command: string, actions: unknown): ToolSubject {
  const inner = unwrapShellCommand(command);
  const action = singleAction(actions);
  if (action?.type === "read" && action.path) {
    const range = sedRange(inner);
    return { kind: "read", path: action.path, ...(range ? { range } : {}) };
  }
  if (action?.type === "listFiles") return { kind: "search", mode: "files", pattern: "*", ...(action.path ? { path: action.path } : {}) };
  if (action?.type === "search") {
    return { kind: "search", mode: "content", pattern: action.query ?? inner, ...(action.path ? { path: action.path } : {}) };
  }
  return { kind: "shell", command: inner };
}

export function commandOutcome(subject: ToolSubject, output: string, exitCode: number | undefined, isError: boolean): ToolOutcome {
  const terminal: ToolOutcome = { kind: "terminal", output, ...(exitCode !== undefined ? { exitCode } : {}) };
  if (isError) return terminal;
  const lines = output.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  if (subject.kind === "read") {
    return { kind: "code", path: subject.path, lines, ...(subject.range ? { startLine: subject.range.start } : {}) };
  }
  if (subject.kind === "search" && subject.mode === "files") {
    return { kind: "files", paths: lines.filter((line) => line !== "") };
  }
  if (subject.kind === "search") {
    const matches = lines
      .filter((line) => line !== "")
      .map((line) => {
        const found = /^(.+?):(\d+):(.*)$/.exec(line);
        return found ? { path: found[1], line: Number(found[2]), text: found[3] } : { path: subject.path ?? "", text: line };
      });
    return { kind: "matches", matches };
  }
  return terminal;
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

export function fileChangeSubject(change: FileChange): ToolSubject {
  return { kind: change.kind?.type === "add" ? "write" : "edit", path: change.path };
}

/** For an update `diff` is a unified diff. For an added or deleted file
 * Codex sends the whole file's content instead, so it becomes an
 * all-added / all-removed hunk. */
export function fileChangeOutcome(change: FileChange): ToolOutcome {
  const diff = typeof change.diff === "string" ? change.diff : "";
  if (change.kind?.type === "update") {
    const hunks = parseUnifiedDiff(diff);
    return { kind: "diff", path: change.path, hunks, ...countPatch(hunks) };
  }
  const lines = diff.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const isAdd = change.kind?.type === "add";
  const marker = isAdd ? "+" : "-";
  const hunk: StructuredPatchHunk = {
    oldStart: isAdd ? 0 : 1,
    oldLines: isAdd ? 0 : lines.length,
    newStart: isAdd ? 1 : 0,
    newLines: isAdd ? lines.length : 0,
    lines: diff === "" ? [] : lines.map((line) => `${marker}${line}`),
  };
  return {
    kind: "diff",
    path: change.path,
    hunks: hunk.lines.length > 0 ? [hunk] : [],
    added: isAdd ? hunk.lines.length : 0,
    removed: isAdd ? 0 : hunk.lines.length,
    ...(isAdd ? { created: true } : {}),
  };
}

interface WebSearchAction {
  type?: string;
  query?: string | null;
  queries?: string[] | null;
  url?: string | null;
  pattern?: string | null;
}

export function webSearchSubject(query: unknown, action: unknown): ToolSubject | undefined {
  const act = (action && typeof action === "object" ? action : {}) as WebSearchAction;
  if ((act.type === "openPage" || act.type === "findInPage") && typeof act.url === "string" && act.url) {
    return { kind: "web", mode: "fetch", url: act.url };
  }
  const text = (typeof act.query === "string" && act.query) || act.queries?.[0] || (typeof query === "string" ? query : "");
  return text ? { kind: "web", mode: "search", query: text } : undefined;
}

/** `results` is opaque JSON at the app-server boundary, so links are
 * extracted defensively: any object carrying a `url` (and, if present, a
 * `title`), at the top level or one level down. */
export function webSearchOutcome(results: unknown): ToolOutcome {
  const links: { title: string; url: string }[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (Array.isArray(value)) {
      if (depth < 3) for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string" && record.url) {
      links.push({ title: typeof record.title === "string" && record.title ? record.title : record.url, url: record.url });
      return;
    }
    if (depth < 3) for (const child of Object.values(record)) if (typeof child === "object") visit(child, depth + 1);
  };
  visit(results, 0);
  return links.length > 0 ? { kind: "links", results: links } : { kind: "text" };
}
