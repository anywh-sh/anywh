// Maps Agent Client Protocol `session/update` notifications to `AgentEvent`s.
// Pure: no spawn, fs, net or clock, and never throws on a shape it doesn't
// know. The vocabulary is ACP's own (agentclientprotocol.com): every ACP
// agent shares this mapper, and a def only says which of its tools to keep
// out of the log.
//
// ACP streams where Codex sends whole items, which is why this mapper keeps
// per-turn state (`JsonRpcDaemonPlan.turnState`):
//   - a message or a thought arrives as `agent_message_chunk` /
//     `agent_thought_chunk` and nothing says it ended, so it is committed
//     when the next different update arrives, or when the turn ends;
//   - a tool call is announced (`tool_call`, often with an empty input),
//     its arguments then stream as partial JSON in `tool_call_update`
//     content, one update carries the parsed `rawInput`, and a final update
//     carries `status: "completed" | "failed"` and the result — the name
//     (`Bash`) only ever comes on the first one, the parsed input only on
//     the middle one, so the call is remembered by id between them;
//   - a history replay (`session/load`) sends the user's own messages as
//     `user_message_chunk`, which is the only place a turn boundary shows.
//
// Shapes below were checked against Kimi Code CLI 2.6.0 (`kimi acp`).
import type { AgentEvent, PlanTodo, ToolKind, ToolOutcome, ToolSubject } from "../../protocol/agent-event.js";
import { splitRoomCard } from "../../protocol/roomCard.js";
import { stripRelayNote } from "../../protocol/relayNote.js";
import type { NotificationContext } from "../types.js";

export interface AcpMapperOptions {
  /** Prefix of the one-time log line for an update this mapper doesn't know. */
  readonly logTag: string;
  /** Tool names (as the `tool_call` titles them) that never become a tool
   * card: a question tool the relay already shows as a choice card. */
  readonly hiddenTools?: ReadonlySet<string>;
}

interface ToolMemo {
  name: string;
  acpKind?: string;
  input?: Record<string, unknown>;
  locations?: readonly string[];
  started: boolean;
  hidden: boolean;
}

export interface AcpTurnState {
  /** Open assistant message, committed as one `text`. */
  text: string;
  textIndex: number;
  /** Open reasoning block, committed as one `thinking`. */
  thought: string | undefined;
  thoughtIndex: number;
  tools: Map<string, ToolMemo>;
  /** History replay only: the user message being assembled, and whether a
   * turn is open (so the next user message closes it first). */
  user: string | undefined;
  turnOpen: boolean;
}

export function createAcpTurnState(): AcpTurnState {
  return { text: "", textIndex: 0, thought: undefined, thoughtIndex: 0, tools: new Map(), user: undefined, turnOpen: false };
}

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
}

interface ToolCallContent {
  readonly type?: string;
  readonly content?: ContentBlock;
  readonly path?: string;
  readonly oldText?: string | null;
  readonly newText?: string;
}

interface SessionUpdate {
  readonly sessionUpdate?: string;
  readonly content?: ContentBlock | readonly ToolCallContent[];
  readonly toolCallId?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly locations?: readonly { readonly path?: string }[];
  readonly entries?: readonly { readonly content?: string; readonly status?: string }[];
  readonly used?: number;
  readonly size?: number;
  readonly currentModeId?: string;
}

/** A relay- or agent-injected block in a replayed user message (Kimi adds
 * the current date as a `<system-reminder>` chunk), which the user never
 * typed. */
const INJECTED_BLOCK = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function commitText(state: AcpTurnState, events: AgentEvent[]): void {
  if (state.text.length > 0) events.push({ type: "text", text: state.text });
  if (state.text.length > 0) state.textIndex += 1;
  state.text = "";
}

function commitThought(state: AcpTurnState, events: AgentEvent[]): void {
  if (state.thought === undefined) return;
  events.push({ type: "thinking", thinking: state.thought });
  state.thought = undefined;
  state.thoughtIndex += 1;
}

function commitUser(state: AcpTurnState, events: AgentEvent[]): void {
  if (state.user === undefined) return;
  const { text, card } = splitRoomCard(stripRelayNote(state.user.trim()));
  state.user = undefined;
  if (!text) return;
  events.push({ type: "user_message", text, ...(card ? { room: card } : {}), ...(card?.kind === "reports" ? { synthetic: "room_digest" as const } : {}) });
}

/** Everything still open, in the order it was opened. */
function commitOpen(state: AcpTurnState, events: AgentEvent[]): void {
  commitUser(state, events);
  commitThought(state, events);
  commitText(state, events);
}

function contentText(content: SessionUpdate["content"]): string {
  if (!Array.isArray(content)) return "";
  return (content as readonly ToolCallContent[])
    .map((item) => (item?.type === "content" && item.content?.type === "text" ? (item.content.text ?? "") : ""))
    .join("");
}

function pathOf(input: Record<string, unknown>, memo: ToolMemo): string | undefined {
  return str(input.path) ?? str(input.file_path) ?? str(input.filePath) ?? memo.locations?.[0];
}

/** What the call is doing, from ACP's own `kind` plus the input fields an
 * agent names the usual way (`command`, `path`, `pattern`, `url`). A call
 * none of that fits is `other`, labelled with the tool's name. */
function acpToolSubject(memo: ToolMemo): { kind: ToolKind; subject: ToolSubject } {
  const input = memo.input ?? {};
  const path = pathOf(input, memo);
  const command = str(input.command);
  const pattern = str(input.pattern) ?? str(input.query);
  const url = str(input.url);
  switch (memo.acpKind ?? "other") {
    case "execute":
      if (command) return { kind: "shell", subject: { kind: "shell", command } };
      break;
    case "read":
      if (path) return { kind: "read", subject: { kind: "read", path } };
      break;
    case "edit":
    case "delete":
    case "move":
      if (path) {
        const writes = typeof input.content === "string" && input.old_string === undefined && input.oldString === undefined;
        return writes ? { kind: "write", subject: { kind: "write", path } } : { kind: "edit", subject: { kind: "edit", path } };
      }
      break;
    case "search":
      if (pattern) return { kind: "search", subject: { kind: "search", mode: "content", pattern, ...(path ? { path } : {}) } };
      break;
    case "fetch":
      if (url) return { kind: "web", subject: { kind: "web", mode: "fetch", url } };
      if (pattern) return { kind: "web", subject: { kind: "web", mode: "search", query: pattern } };
      break;
    default:
      // `think`, `switch_mode`, `other`, or a kind ACP adds later.
      break;
  }
  return { kind: "other", subject: { kind: "other", label: memo.name } };
}

function toolOutcome(subject: ToolSubject, output: string): ToolOutcome | undefined {
  // ACP reports no exit code, so none is shown.
  if (subject.kind === "shell") return { kind: "terminal", output };
  return undefined;
}

function startTool(id: string, memo: ToolMemo, events: AgentEvent[]): void {
  memo.started = true;
  if (memo.hidden) return;
  const { kind, subject } = acpToolSubject(memo);
  events.push({ type: "tool_started", toolUseId: id, name: memo.name, kind, input: memo.input ?? {}, subject });
}

function onToolUpdate(update: SessionUpdate, state: AcpTurnState, options: AcpMapperOptions, events: AgentEvent[]): void {
  const id = update.toolCallId;
  if (!id) return;
  let memo = state.tools.get(id);
  if (!memo) {
    // A `tool_call` names the tool; an update arriving first (or a replay
    // that only sent updates) falls back to its own title.
    const name = str(update.title) ?? "tool";
    memo = { name, started: false, hidden: options.hiddenTools?.has(name) ?? false };
    state.tools.set(id, memo);
  }
  if (update.kind) memo.acpKind = update.kind;
  if (isRecord(update.rawInput)) memo.input = update.rawInput;
  if (update.locations) memo.locations = update.locations.map((location) => location.path).filter((path): path is string => typeof path === "string");

  if (!memo.started && memo.input) startTool(id, memo, events);

  if (update.status === "completed" || update.status === "failed") {
    if (!memo.started) startTool(id, memo, events);
    state.tools.delete(id);
    if (memo.hidden) return;
    const isError = update.status === "failed";
    const output = typeof update.rawOutput === "string" ? update.rawOutput : contentText(update.content) || (update.rawOutput !== undefined ? JSON.stringify(update.rawOutput) : "");
    const outcome = toolOutcome(acpToolSubject(memo).subject, output);
    events.push({ type: "tool_ended", toolUseId: id, content: output, isError, ...(outcome ? { outcome } : {}) });
  }
}

const PLAN_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

const loggedUnrecognized = new Set<string>();

function logUnrecognizedOnce(tag: string, key: string): void {
  const id = `${tag}:${key}`;
  if (loggedUnrecognized.has(id)) return;
  loggedUnrecognized.add(id);
  console.error(`[relay] unrecognized ${tag} ACP update "${key}", dropping it`);
}

/** Updates that carry nothing the log shows: the agent's own title for the
 * session (the relay names sessions itself), its slash commands, and the
 * config/mode echo of what the relay just set. */
const IGNORED_UPDATES: ReadonlySet<string> = new Set(["session_info_update", "available_commands_update", "config_option_update"]);

export function mapAcpUpdate(params: unknown, state: AcpTurnState, options: AcpMapperOptions): AgentEvent[] {
  const update = (isRecord(params) ? params.update : undefined) as SessionUpdate | undefined;
  const kind = update?.sessionUpdate;
  if (!update || !kind) return [];
  const events: AgentEvent[] = [];

  switch (kind) {
    case "agent_message_chunk": {
      const block = update.content as ContentBlock | undefined;
      if (block?.type !== "text" || !block.text) return [];
      commitUser(state, events);
      commitThought(state, events);
      state.text += block.text;
      events.push({ type: "text_delta", index: state.textIndex, text: block.text });
      return events;
    }
    case "agent_thought_chunk": {
      const block = update.content as ContentBlock | undefined;
      if (block?.type !== "text" || typeof block.text !== "string") return [];
      commitUser(state, events);
      commitText(state, events);
      if (state.thought === undefined) {
        state.thought = "";
        events.push({ type: "thinking_started" });
      }
      state.thought += block.text;
      events.push({ type: "thinking_delta", index: state.thoughtIndex, thinking: block.text });
      return events;
    }
    case "user_message_chunk": {
      const block = update.content as ContentBlock | undefined;
      const text = block?.type === "text" ? (block.text ?? "") : "";
      if (state.user === undefined) {
        commitThought(state, events);
        commitText(state, events);
        if (state.turnOpen) events.push({ type: "turn_ended", stopped: false });
        events.push({ type: "turn_started" });
        state.turnOpen = true;
        state.user = "";
      }
      if (!INJECTED_BLOCK.test(text)) state.user += text;
      return events;
    }
    case "tool_call":
    case "tool_call_update":
      commitOpen(state, events);
      onToolUpdate(update, state, options, events);
      return events;
    case "plan": {
      commitOpen(state, events);
      const todos: PlanTodo[] = (update.entries ?? [])
        .filter((entry) => typeof entry.content === "string")
        .map((entry) => ({ content: entry.content as string, status: PLAN_STATUSES.has(entry.status ?? "") ? (entry.status as PlanTodo["status"]) : "pending" }));
      events.push({ type: "plan", todos });
      return events;
    }
    case "usage_update":
      // `used` is the whole context the session holds right now, `size` the
      // model's window — ACP reports nothing finer, so the per-category
      // fields stay zero and `prefixTokens` (the one comparable number)
      // carries it.
      if (typeof update.used !== "number") return [];
      return [
        {
          type: "usage",
          inputTokens: update.used,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          prefixTokens: update.used,
          outputTokens: 0,
          ...(typeof update.size === "number" ? { contextWindowSize: update.size } : {}),
        },
      ];
    case "current_mode_update":
      return typeof update.currentModeId === "string" ? [{ type: "status", permissionMode: update.currentModeId }] : [];
    default:
      if (!IGNORED_UPDATES.has(kind)) logUnrecognizedOnce(options.logTag, kind);
      return [];
  }
}

/** Commits what is still open when a turn (or a replay) ends. */
export function flushAcpTurn(state: AcpTurnState): AgentEvent[] {
  const events: AgentEvent[] = [];
  commitOpen(state, events);
  if (state.turnOpen) {
    events.push({ type: "turn_ended", stopped: false });
    state.turnOpen = false;
  }
  return events;
}

/** The `mapNotification`/`turnState` pair an ACP def plugs into its
 * `JsonRpcDaemonPlan`. Every notification an ACP agent sends during a turn
 * is a `session/update`; anything else is dropped. */
export function acpNotificationMapping(options: AcpMapperOptions): {
  readonly mapNotification: (method: string, params: unknown, ctx: NotificationContext) => readonly AgentEvent[];
  readonly turnState: { readonly create: () => unknown; readonly flush: (state: unknown) => readonly AgentEvent[] };
} {
  return {
    mapNotification: (method, params, ctx) => {
      if (method !== "session/update") return [];
      const state = (ctx.state as AcpTurnState | undefined) ?? createAcpTurnState();
      return mapAcpUpdate(params, state, options);
    },
    turnState: { create: createAcpTurnState, flush: (state) => flushAcpTurn(state as AcpTurnState) },
  };
}
