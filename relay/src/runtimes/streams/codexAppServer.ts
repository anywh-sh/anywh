import type { AgentEvent, ToolInput } from "../../protocol/agent-event.js";

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
    case "item/agentMessage/delta":
      // No AgentEvent produced: `text_delta.index` is a number correlating
      // concurrently-streaming content blocks by position, a shape that
      // came from Anthropic's Messages API — Codex correlates by `itemId`
      // (a string) instead, and there's no honest way to turn one into the
      // other without either faking a number or extending `AgentEvent`
      // itself (a `protocol/agent-event.ts` change with a client-side
      // mirror to keep in sync, out of scope here). Only the item's final,
      // committed text (`item/completed`'s `agentMessage`) is reported for
      // now — live-preview streaming for Codex is a known gap, not a
      // silent one.
      return [];
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
  content: string[];
}

interface CommandExecutionItem {
  type: "commandExecution";
  id: string;
  command: string;
  cwd?: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  aggregatedOutput: string | null;
  exitCode: number | null;
}

interface FileChangeItem {
  type: "fileChange";
  id: string;
  changes: unknown[];
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
 * realtime/collab-agent items, ...) — not mapped for Tier 0, falls through
 * to the unrecognized-item log. */
type ThreadItemSubset = AgentMessageItem | ReasoningItem | CommandExecutionItem | FileChangeItem | McpToolCallItem | PlanItem | { type: string };

interface ItemLifecycleParams {
  item: ThreadItemSubset;
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

function mapItemStarted(params: ItemLifecycleParams): AgentEvent[] {
  const item = params?.item;
  if (!item) return [];
  switch (item.type) {
    case "commandExecution": {
      const commandItem = item as CommandExecutionItem;
      return [{ type: "tool_started", toolUseId: commandItem.id, name: "commandExecution", kind: "shell", input: { command: commandItem.command } }];
    }
    case "fileChange": {
      const fileChangeItem = item as FileChangeItem;
      return [{ type: "tool_started", toolUseId: fileChangeItem.id, name: "fileChange", kind: "edit", input: {} }];
    }
    case "mcpToolCall": {
      const mcpItem = item as McpToolCallItem;
      return [{ type: "tool_started", toolUseId: mcpItem.id, name: `${mcpItem.server}:${mcpItem.tool}`, kind: "mcp", input: toolInputFrom(mcpItem.arguments) }];
    }
    // agentMessage/reasoning/plan starting is a no-op here — their content
    // arrives whole at item/completed (or, for agentMessage, would arrive
    // incrementally via item/agentMessage/delta if that were mapped — see
    // mapCodexNotification's own comment on why it isn't yet).
    case "agentMessage":
    case "reasoning":
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
  switch (item.type) {
    case "agentMessage":
      return [{ type: "text", text: (item as AgentMessageItem).text }];
    case "reasoning": {
      const reasoningItem = item as ReasoningItem;
      return reasoningItem.content.length > 0 ? [{ type: "thinking", thinking: reasoningItem.content.join("\n") }] : [];
    }
    case "plan":
      return [{ type: "text", text: (item as PlanItem).text }];
    case "commandExecution": {
      const commandItem = item as CommandExecutionItem;
      return [
        {
          type: "tool_ended",
          toolUseId: commandItem.id,
          content: commandItem.aggregatedOutput ?? "",
          isError: commandItem.status !== "completed",
        },
      ];
    }
    case "fileChange": {
      const fileChangeItem = item as FileChangeItem;
      return [
        {
          type: "tool_ended",
          toolUseId: fileChangeItem.id,
          content: JSON.stringify(fileChangeItem.changes),
          isError: fileChangeItem.status !== "completed",
        },
      ];
    }
    case "mcpToolCall": {
      const mcpItem = item as McpToolCallItem;
      return [
        {
          type: "tool_ended",
          toolUseId: mcpItem.id,
          content: JSON.stringify(mcpItem.error ?? mcpItem.result ?? null),
          isError: mcpItem.status !== "completed",
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
