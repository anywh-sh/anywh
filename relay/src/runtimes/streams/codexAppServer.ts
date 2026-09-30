import type { AgentEvent, ToolInput } from "../../protocol/agent-event.js";
import {
  commandOutcome,
  commandSubject,
  fileChangeOutcome,
  fileChangeSubject,
  webSearchOutcome,
  webSearchSubject,
  type FileChange,
} from "./codexToolMapping.js";

/**
 * Maps one already-decoded Codex `app-server` notification — `method` and
 * `params`, not a raw line (see `NotificationMapper`'s own doc comment in
 * `../types.ts` for why) — into zero or more `AgentEvent`s. Pure: no
 * `spawn`, `fs`, or `net`, and never throws on a shape it doesn't recognize.
 *
 * Field names and notification shapes below were captured from
 * `codex app-server generate-ts --experimental` against a real
 * `codex-cli 0.154.0`, logged in via ChatGPT — not from documentation. Only
 * the subset this relay actually consumes is reproduced here (locally, not
 * vendored in full — see this file's own PR for why a curated subset beats
 * committing the entire generated surface, most of which this relay will
 * never touch: marketplace, plugins, realtime voice, and dozens of other
 * app-server concerns unrelated to running a coding turn).
 *
 * Turn lifecycle (`turn_started`/`turn_ended`/`error`) is deliberately NOT
 * produced here, same as `runtimes/streams/claudeStreamJson.ts` — those are
 * synthesized by the session layer, which knows a turn's real boundaries
 * structurally. `turn/started`/`turn/completed` notifications exist on the
 * wire but aren't mapped for that reason.
 */
export function mapCodexNotification(method: string, params: unknown): AgentEvent[] {
  switch (method) {
    case "item/started":
      return mapItemStarted(params as ItemLifecycleParams);
    case "item/completed":
      return mapItemCompleted(params as ItemLifecycleParams);
    case "item/agentMessage/delta": {
      // Codex correlates streaming blocks by `itemId`, hence the string index.
      const delta = params as ItemDeltaParams;
      return typeof delta?.itemId === "string" && typeof delta.delta === "string" ? [{ type: "text_delta", index: delta.itemId, text: delta.delta }] : [];
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const delta = params as ItemDeltaParams;
      return typeof delta?.itemId === "string" && typeof delta.delta === "string"
        ? [{ type: "thinking_delta", index: delta.itemId, thinking: delta.delta }]
        : [];
    }
    case "thread/tokenUsage/updated":
      return mapTokenUsageUpdated(params as ThreadTokenUsageUpdatedParams);
    default:
      logUnrecognizedOnce(method);
      return [];
  }
}

// ---------------------------------------------------------------------------
// Locally-typed subset of ThreadItem/notification params this file
// consumes — see the file doc comment on why this isn't the full vendored
// `generate-ts` output.

interface AgentMessageItem {
  type: "agentMessage";
  id: string;
  text: string;
}

interface ReasoningItem {
  type: "reasoning";
  id: string;
  summary?: string[];
  content: string[];
}

interface CommandExecutionItem {
  type: "commandExecution";
  id: string;
  command: string;
  cwd?: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  commandActions?: unknown;
  aggregatedOutput: string | null;
  exitCode: number | null;
}

interface FileChangeItem {
  type: "fileChange";
  id: string;
  changes: FileChange[];
  status: "inProgress" | "completed" | "failed" | "declined";
}

interface McpToolCallItem {
  type: "mcpToolCall";
  id: string;
  server: string;
  tool: string;
  status: "inProgress" | "completed" | "failed";
  arguments: unknown;
  result: unknown;
  error: unknown;
}

interface WebSearchItem {
  type: "webSearch";
  id: string;
  query: string;
  action: unknown;
  results: unknown;
}

interface PlanItem {
  type: "plan";
  id: string;
  /** A single free-text plan, not Claude's `TodoWrite`-shaped checklist —
   * real Codex `plan` items carry prose, never itemized todos with a
   * status each. Forcing that into `AgentEvent`'s structured `plan` variant
   * (`todos: PlanTodo[]`) would mean inventing a status per line that isn't
   * in the payload, so this maps to plain `text` instead — honest about
   * what the data actually is. */
  text: string;
}

/** Every other `ThreadItem` variant (`userMessage`, `hookPrompt`,
 * `functionCallOutput`, `dynamicToolCall`, `imageGeneration`, `sleep`, the
 * realtime/collab-agent items, ...) — not mapped yet, falls through to the
 * unrecognized-item log. */
type ThreadItemSubset =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | PlanItem
  | { type: string };

/** `startedAtMs`/`completedAtMs` are the daemon's own clock for the item —
 * epoch ms, carried on the notification rather than on the item. */
interface ItemLifecycleParams {
  item: ThreadItemSubset;
  startedAtMs?: number;
  completedAtMs?: number;
}

interface ItemDeltaParams {
  itemId?: string;
  delta?: string;
}

interface ThreadTokenUsageUpdatedParams {
  tokenUsage: {
    last: {
      inputTokens: number;
      cacheWriteInputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
    };
    modelContextWindow?: number;
  };
}

function timed<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  return (typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {}) as { [P in K]?: number };
}

function mapItemStarted(params: ItemLifecycleParams): AgentEvent[] {
  const item = params?.item;
  if (!item) return [];
  const startedAt = timed("startedAt", params.startedAtMs);
  switch (item.type) {
    case "commandExecution": {
      const commandItem = item as CommandExecutionItem;
      const subject = commandSubject(commandItem.command, commandItem.commandActions);
      return [
        {
          type: "tool_started",
          toolUseId: commandItem.id,
          name: "commandExecution",
          kind: subject.kind === "read" || subject.kind === "search" ? subject.kind : "shell",
          input: { command: commandItem.command },
          subject,
          ...startedAt,
        },
      ];
    }
    case "fileChange": {
      // One call per file: a single patch can touch several, and the display
      // shows each as its own edit or write.
      const fileChangeItem = item as FileChangeItem;
      return (fileChangeItem.changes ?? []).map((change, index) => {
        const subject = fileChangeSubject(change);
        return {
          type: "tool_started" as const,
          toolUseId: `${fileChangeItem.id}#${index}`,
          name: "fileChange",
          kind: subject.kind === "write" ? ("write" as const) : ("edit" as const),
          input: { file_path: change.path },
          subject,
          ...startedAt,
        };
      });
    }
    case "mcpToolCall": {
      const mcpItem = item as McpToolCallItem;
      return [
        {
          type: "tool_started",
          toolUseId: mcpItem.id,
          name: `${mcpItem.server}:${mcpItem.tool}`,
          kind: "mcp",
          input: toolInputFrom(mcpItem.arguments),
          subject: { kind: "mcp", server: mcpItem.server, tool: mcpItem.tool },
          ...startedAt,
        },
      ];
    }
    case "webSearch": {
      const searchItem = item as WebSearchItem;
      const subject = webSearchSubject(searchItem.query, searchItem.action);
      return [
        {
          type: "tool_started",
          toolUseId: searchItem.id,
          name: "webSearch",
          kind: "web",
          input: { query: searchItem.query },
          ...(subject ? { subject } : {}),
          ...startedAt,
        },
      ];
    }
    case "reasoning":
      return [{ type: "thinking_started", ...startedAt }];
    // agentMessage/plan starting is a no-op — their text arrives at
    // item/completed (and, for agentMessage, incrementally as deltas).
    case "agentMessage":
    case "plan":
      return [];
    default:
      logUnrecognizedOnce(`item:${item.type}`);
      return [];
  }
}

function mapItemCompleted(params: ItemLifecycleParams): AgentEvent[] {
  const item = params?.item;
  if (!item) return [];
  const endedAt = timed("endedAt", params.completedAtMs);
  switch (item.type) {
    case "agentMessage":
      return [{ type: "text", text: (item as AgentMessageItem).text }];
    case "reasoning": {
      const reasoningItem = item as ReasoningItem;
      // The raw reasoning text is often empty while the model still reports
      // a summary — the summary is what's worth showing then. Emitted even
      // when both are empty: the block still matters for its timing.
      const content = reasoningItem.content ?? [];
      const source = content.length > 0 ? content : (reasoningItem.summary ?? []);
      return [{ type: "thinking", thinking: source.join("\n"), ...endedAt }];
    }
    case "plan":
      return [{ type: "text", text: (item as PlanItem).text }];
    case "commandExecution": {
      const commandItem = item as CommandExecutionItem;
      const output = commandItem.aggregatedOutput ?? "";
      const isError = commandItem.status !== "completed";
      const subject = commandSubject(commandItem.command, commandItem.commandActions);
      return [
        {
          type: "tool_ended",
          toolUseId: commandItem.id,
          content: output,
          isError,
          outcome: commandOutcome(subject, output, commandItem.exitCode ?? undefined, isError),
          ...endedAt,
        },
      ];
    }
    case "fileChange": {
      const fileChangeItem = item as FileChangeItem;
      const isError = fileChangeItem.status !== "completed";
      return (fileChangeItem.changes ?? []).map((change, index) => ({
        type: "tool_ended" as const,
        toolUseId: `${fileChangeItem.id}#${index}`,
        content: typeof change.diff === "string" ? change.diff : "",
        isError,
        outcome: fileChangeOutcome(change),
        ...endedAt,
      }));
    }
    case "mcpToolCall": {
      const mcpItem = item as McpToolCallItem;
      const content = JSON.stringify(mcpItem.error ?? mcpItem.result ?? null);
      return [
        {
          type: "tool_ended",
          toolUseId: mcpItem.id,
          content,
          isError: mcpItem.status !== "completed",
          outcome: { kind: "payload", request: JSON.stringify(mcpItem.arguments ?? {}, null, 2), response: content },
          ...endedAt,
        },
      ];
    }
    case "webSearch": {
      const searchItem = item as WebSearchItem;
      const outcome = webSearchOutcome(searchItem.results);
      return [
        {
          type: "tool_ended",
          toolUseId: searchItem.id,
          content: outcome.kind === "links" ? outcome.results.map((link) => `${link.title}\n${link.url}`).join("\n\n") : "",
          isError: false,
          outcome,
          ...endedAt,
        },
      ];
    }
    default:
      logUnrecognizedOnce(`item:${item.type}`);
      return [];
  }
}

function toolInputFrom(value: unknown): ToolInput {
  return value && typeof value === "object" ? (value as ToolInput) : {};
}

/**
 * Maps Codex's per-response token usage (`tokenUsage.last`) to `AgentEvent`'s
 * `usage` variant, which is explicitly per-response, never a turn-wide
 * aggregate (see `runtimes/defs/claude/session.ts`'s own doc comment on why
 * an aggregate is actively misleading) — `tokenUsage.total`, the running sum
 * across the whole thread, is deliberately not used here for the same
 * reason. Field correspondence by *name* only, not by *semantics*: Codex's
 * `cacheWriteInputTokens` lands in `cacheCreationInputTokens` and
 * `cachedInputTokens` lands in `cacheReadInputTokens`, but unlike Claude's
 * fields — which are additive slices of the prefix — Codex's
 * `cachedInputTokens` is already a *subset* of `inputTokens`. Summing all
 * three the way Claude's mapper does would double-count the cached slice, so
 * `prefixTokens` here is `inputTokens` alone.
 */
function mapTokenUsageUpdated(params: ThreadTokenUsageUpdatedParams): AgentEvent[] {
  const last = params?.tokenUsage?.last;
  if (!last) return [];
  return [
    {
      type: "usage",
      inputTokens: last.inputTokens,
      cacheCreationInputTokens: last.cacheWriteInputTokens,
      cacheReadInputTokens: last.cachedInputTokens,
      prefixTokens: last.inputTokens,
      outputTokens: last.outputTokens,
      ...(params.tokenUsage.modelContextWindow !== undefined ? { contextWindowSize: params.tokenUsage.modelContextWindow } : {}),
    },
  ];
}

// Logged once per method/item-type, not per occurrence — same reasoning as
// claudeStreamJson.ts's classifyToolKind: a long session shouldn't spam
// stderr for something already known to be unmapped, but a genuinely new
// one (a Codex update) is worth knowing about at least once.
const loggedUnrecognized = new Set<string>();

function logUnrecognizedOnce(key: string): void {
  if (loggedUnrecognized.has(key)) return;
  loggedUnrecognized.add(key);
  console.error(`[relay] unrecognized Codex notification "${key}", dropping it`);
}
