import { isMainThreadEvent, type ClaudeEvent } from "../defs/claude/index.js";
import type { AgentEvent, PlanTodo, StructuredPatchHunk, ToolInput, ToolKind } from "../../protocol/agent-event.js";

/**
 * Maps one raw `ClaudeEvent` — a single stream-json line the CLI printed, or
 * one of the synthetic shapes `sharedSession.ts`/`transcriptReader.ts` build
 * for a user message — into zero or more `AgentEvent`s. Pure: no `spawn`,
 * `fs`, or `net`, and never throws on a shape it doesn't recognize (a CLI
 * version bump adding a field/subtype should degrade to "nothing new to
 * report", not a crash).
 *
 * Turn lifecycle (`turn_started`/`turn_ended`/`error`) is deliberately NOT
 * produced here — those are synthesized by the caller (`sharedSession.ts` for
 * a live turn, `transcriptReader.ts` for a replayed one), which knows the
 * turn's real boundaries structurally. Nothing in a single stream-json line
 * says "this is where the turn starts or ends".
 *
 * Callers are expected to have already applied the CLI's own filtering
 * before calling this: a `"user"` event only ever reaches here when it's
 * tool-result-only (`isToolResultOnly` — both call sites already enforce
 * this upstream, for their own separate reasons), and a subagent's events
 * (`parent_tool_use_id` set) are NOT filtered out here, matching the
 * pre-existing behavior of the code this replaces — only `usage` extraction
 * cares about main-thread vs. subagent, for the reason `session.ts`'s own
 * `extractContextUsage` doc comment already gives.
 */
export function mapClaudeEvent(event: ClaudeEvent): AgentEvent[] {
  switch (event.type) {
    case "user_prompt":
      return mapUserPrompt(event);
    case "assistant":
    case "user":
      return mapMessageContent(event);
    case "stream_event":
      return mapStreamEvent(event);
    case "system":
      return mapSystemEvent(event);
    case "result":
      return typeof event.session_id === "string" ? [{ type: "session_id", sessionId: event.session_id }] : [];
    default:
      // Unrecognized top-level type — silently dropped, same as today (the
      // code this replaces never had a branch for it either).
      return [];
  }
}

interface RawContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
}

interface RawMessage {
  content?: unknown;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

function mapMessageContent(event: ClaudeEvent): AgentEvent[] {
  const results: AgentEvent[] = [];
  const message = event.message as RawMessage | undefined;

  // Only ever present on `assistant` (a `user` tool-result event has no
  // `usage`) — see the `usage` variant's own doc comment on why this is the
  // per-response number, never the turn-wide aggregate.
  if (event.type === "assistant" && isMainThreadEvent(event) && message?.usage) {
    const inputTokens = message.usage.input_tokens ?? 0;
    const cacheCreationInputTokens = message.usage.cache_creation_input_tokens ?? 0;
    const cacheReadInputTokens = message.usage.cache_read_input_tokens ?? 0;
    results.push({
      type: "usage",
      inputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      // Claude's three fields are additive — cache_creation and cache_read
      // are each their own slice of the prefix, never a subset of input.
      prefixTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens,
      // MEASURED, not assumed: this live stream's `output_tokens` is stuck
      // near a small constant regardless of the real reply length — checked
      // against the SAME response's own persisted transcript
      // (~/.claude/projects/<slug>/<session>.jsonl) twice, live vs
      // persisted 1-vs-3 and 1-vs-21 tokens for a 1-line and a 10-line
      // reply respectively. The correct number exists only in the
      // turn-ending `result` event's `usage`/`modelUsage`, which is a
      // turn-wide aggregate (may include subagents) rather than this one
      // response's own count — there is no live, per-response, accurate
      // output-token source for Claude today. A consumer computing
      // attribution from `outputTokens` will systematically undercount it.
      outputTokens: message.usage.output_tokens ?? 0,
    });
  }

  const content = message?.content;
  if (!Array.isArray(content)) return results;
  const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;

  for (const raw of content as RawContentBlock[]) {
    if (!raw || typeof raw !== "object") continue;

    if (raw.type === "text" && typeof raw.text === "string") {
      // Synthetic marker the CLI itself inserts into the transcript when
      // interrupted (`[Request interrupted by user]`, `[...for tool use]`,
      // `[...by a plugin for tool use]`) — not real assistant content. The
      // session's own `turn_ended.stopped` already covers this notice, so
      // committing this too would duplicate the message on screen.
      if (raw.text.startsWith("[Request interrupted")) continue;
      results.push({ type: "text", text: raw.text, ...(timestamp ? { timestamp } : {}) });
    } else if (raw.type === "thinking" && typeof raw.thinking === "string") {
      results.push({ type: "thinking", thinking: raw.thinking, ...(timestamp ? { timestamp } : {}) });
    } else if (raw.type === "tool_use") {
      const name = typeof raw.name === "string" ? raw.name : "tool";
      const toolUseId = typeof raw.id === "string" ? raw.id : undefined;
      const input = (raw.input && typeof raw.input === "object" ? raw.input : {}) as ToolInput;
      // TodoWrite carries structured planning data, not an arbitrary tool
      // call — see `AgentEvent`'s `plan` variant doc comment.
      if (name === "TodoWrite") {
        results.push({ type: "plan", toolUseId, todos: parseTodos(input.todos) });
      } else {
        results.push({ type: "tool_started", toolUseId, name, kind: classifyToolKind(name), input });
      }
    } else if (raw.type === "tool_result") {
      const toolUseResult = event.tool_use_result as { structuredPatch?: StructuredPatchHunk[] } | undefined;
      results.push({
        type: "tool_ended",
        toolUseId: raw.tool_use_id,
        content: flattenToolResultContent(raw.content),
        isError: raw.is_error === true,
        ...(toolUseResult?.structuredPatch ? { structuredPatch: toolUseResult.structuredPatch } : {}),
      });
    }
    // Other block types (redacted_thinking, ...) have no representation
    // today — dropped, same as before.
  }

  return results;
}

/**
 * A `tool_result`'s `content` is a plain string in every real case observed
 * (confirmed against the live binary), but the Messages API also allows an
 * array of text blocks — flattened here, once, so every consumer (the log
 * renderer, `backgroundJobs.ts`'s marker detection) gets a plain string and
 * never needs to know the array shape existed. Anything else (genuinely not
 * text-representable) falls back to `JSON.stringify`, same as the client
 * code this replaces already did for the plain-string case's fallback.
 */
function flattenToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return JSON.stringify(content);
}

function parseTodos(value: unknown): PlanTodo[] {
  if (!Array.isArray(value)) return [];
  const todos: PlanTodo[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { content, status, activeForm } = item as Record<string, unknown>;
    if (typeof content !== "string") continue;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
    todos.push({ content, status, ...(typeof activeForm === "string" ? { activeForm } : {}) });
  }
  return todos;
}

// Logged once per name, not per occurrence — a tool called repeatedly in a
// long session shouldn't spam stderr, but a genuinely new/unrecognized name
// (a CLI update, an MCP tool) is worth knowing about at least once.
const loggedUnknownTools = new Set<string>();

function classifyToolKind(name: string): ToolKind {
  switch (name) {
    case "Bash":
      return "shell";
    case "Edit":
      return "edit";
    case "Write":
      return "write";
    case "Read":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
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

function mapUserPrompt(event: ClaudeEvent): AgentEvent[] {
  const message = event.message as RawMessage | undefined;
  const content = message?.content;
  const block = Array.isArray(content) ? (content[0] as { type?: string; text?: unknown } | undefined) : undefined;
  const text = block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
  if (text === undefined) return [];

  const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
  const label = typeof event.label === "string" ? event.label : undefined;
  return [
    {
      type: "user_message",
      text,
      ...(timestamp ? { timestamp } : {}),
      ...(event.synthetic === "background_job" ? { synthetic: "background_job", ...(label ? { label } : {}) } : {}),
    },
  ];
}

interface RawStreamEvent {
  type?: string;
  index?: number;
  delta?: { type?: string; text?: string; thinking?: string };
}

/**
 * Only the two live-preview deltas the client actually renders today
 * (`text_delta`/`thinking_delta`) — `message_start`/`content_block_start`/
 * `content_block_stop`/`message_delta`/`message_stop`, and a `content_block_delta`
 * of any other kind (`input_json_delta`, tool argument streaming), have no
 * consumer yet, dropped the same way they're silently dropped today.
 */
function mapStreamEvent(event: ClaudeEvent): AgentEvent[] {
  const se = event.event as RawStreamEvent | undefined;
  if (!se || se.type !== "content_block_delta" || typeof se.index !== "number" || !se.delta) return [];
  if (se.delta.type === "text_delta" && typeof se.delta.text === "string") {
    return [{ type: "text_delta", index: se.index, text: se.delta.text }];
  }
  if (se.delta.type === "thinking_delta" && typeof se.delta.thinking === "string") {
    return [{ type: "thinking_delta", index: se.index, thinking: se.delta.thinking }];
  }
  return [];
}

interface RawCompactMetadata {
  trigger?: string;
  preTokens?: number;
}

function mapSystemEvent(event: ClaudeEvent): AgentEvent[] {
  const results: AgentEvent[] = [];
  if (typeof event.session_id === "string") results.push({ type: "session_id", sessionId: event.session_id });

  if (event.subtype === "compact_boundary" && event.compactMetadata) {
    const meta = event.compactMetadata as RawCompactMetadata;
    if ((meta.trigger === "auto" || meta.trigger === "manual") && typeof meta.preTokens === "number") {
      results.push({ type: "compact_boundary", trigger: meta.trigger, preTokens: meta.preTokens });
    }
  }

  if (event.subtype === "status" && typeof event.permissionMode === "string") {
    results.push({ type: "status", permissionMode: event.permissionMode });
  }

  return results;
}
