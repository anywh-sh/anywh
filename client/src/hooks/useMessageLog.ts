import { useMemo, useReducer } from "react";
import type { AgentEvent, HistoryMessage, HistoryPageMessage, StructuredPatchHunk, ToolInput } from "@/lib/relay-types";
import type { PendingAttachment } from "@/hooks/useImageUpload";

export type LogEntry =
  | { kind: "user"; id: string; text: string; images?: PendingAttachment[]; sentAt: number }
  | { kind: "text"; id: string; text: string; streaming: boolean; sentAt: number }
  | { kind: "tool-use"; id: string; toolUseId?: string; name: string; input: ToolInput }
  | {
      kind: "tool-result";
      id: string;
      toolUseId?: string;
      content: string;
      isError: boolean;
      structuredPatch?: StructuredPatchHunk[];
    }
  | { kind: "error"; id: string; message: string }
  | { kind: "stopped"; id: string }
  /** Automatic follow-up turn from an `anywh-bg` job that finished —
   * the synthetic prompt itself never becomes a
   * user bubble (the text is an internal instruction, not something the
   * user typed); this is just the note indicating where the following
   * response came from, same pattern as "stopped" (system note, no bubble). */
  | { kind: "background-job-note"; id: string; label: string };

interface StreamingTextBlock {
  index: number;
  text: string;
}

interface MessageLogState {
  entries: LogEntry[];
  streamingText: StreamingTextBlock[];
  /** Whether there are turns older than `historyCursor` to fetch via
   * `load_older_history`. `false` until the initial
   * tail arrives (`HYDRATE`) — same default value as before this feature
   * existed (session with no history at all to paginate). */
  hasMoreHistory: boolean;
  /** Position (in the relay's `history`) of the oldest page already loaded
   * — `null` until `HYDRATE`. This is what gets sent back as `beforeCursor`
   * to request the next, older page. */
  historyCursor: number | null;
  /** Older-page request in flight — guards against a duplicate request
   * (Phase 5, UI: scrolling up triggers `beginLoadingOlderHistory` before
   * calling `loadOlderHistory` on the relay). */
  loadingOlderHistory: boolean;
}

type Action =
  | { type: "USER_MESSAGE"; text: string; images?: PendingAttachment[]; sentAt: number }
  /** Message editing — truncates `entries` up to (exclusive) the
   * entry `id` (edited message and everything that came after, on this
   * device's screen) and pushes the new one, optimistically, same as
   * `USER_MESSAGE`. The relay does the real cut (actual transcript +
   * in-memory `history`) asynchronously; this here just gets ahead of the
   * local UI, same spirit as the rest of the reducer. */
  | { type: "EDIT_USER_MESSAGE"; id: string; text: string; sentAt: number }
  | { type: "AGENT_EVENT"; event: AgentEvent }
  /** `relayClient.ts` already split `turn_ended`/`error` out of the live
   * `AgentEvent` stream into `onTurnComplete`/`onTurnError` (see
   * `RelayClientCallbacks.onEvent`'s doc comment) — these two actions
   * reconstruct the same event shape `applyAgentEvent` expects, so live
   * dispatch and history replay share one code path. */
  | { type: "TURN_ERROR"; message: string }
  | { type: "TURN_COMPLETE"; stopped: boolean }
  | { type: "RESET" }
  /** Initial tail received via `history_page` — swaps
   * the old replay (one dispatch per event, O(n²) `entries` copying) for a
   * single dispatch that already delivers the final state. */
  | { type: "HYDRATE"; messages: HistoryMessage[]; cursor: number; hasMore: boolean }
  | { type: "REQUEST_OLDER_HISTORY" }
  /** Response to `load_older_history` — turns older
   * than `historyCursor`, inserted at the start of the log. */
  | { type: "PREPEND_HISTORY"; messages: HistoryMessage[]; cursor: number; hasMore: boolean };

const initialState: MessageLogState = {
  entries: [],
  streamingText: [],
  hasMoreHistory: false,
  historyCursor: null,
  loadingOlderHistory: false,
};

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Applies a single `AgentEvent` — used both by live dispatch (`handleEvent`/
 * `handleTurnComplete`/`handleTurnError`, one at a time) and by batch
 * hydration (`HYDRATE`/`PREPEND_HISTORY`, folding a whole history page
 * through this same function). Several variants have no visual
 * representation yet (`session_id`, `usage`, `status`, `compact_boundary`,
 * `thinking`/`thinking_delta`, `tool_input_delta`, `tool_progress`) — a
 * no-op here, same as before this vocabulary had names at all; a future UI
 * feature (a thinking bubble, live tool-argument streaming, a todo-list
 * widget) is what would give one of these its own branch.
 */
function applyAgentEvent(state: MessageLogState, event: AgentEvent): MessageLogState {
  switch (event.type) {
    case "turn_started":
    case "session_id":
    case "usage":
    case "status":
    case "compact_boundary":
    case "thinking":
    case "thinking_delta":
    case "tool_input_delta":
    case "tool_progress":
      return state;

    case "user_message": {
      if (event.synthetic === "background_job") {
        return { ...state, entries: [...state.entries, { kind: "background-job-note", id: newId(), label: event.label ?? "job em background" }] };
      }
      // `event.timestamp` only comes filled in during replay/history or in
      // the broadcast to OTHER devices — whoever sent the message already
      // committed it via `USER_MESSAGE` with the local click time, it never
      // goes through here for its own message. The `Date.now()` fallback
      // would only cover an unexpected event format, shouldn't happen in
      // practice.
      const sentAt = event.timestamp ? Date.parse(event.timestamp) : Date.now();
      return { ...state, entries: [...state.entries, { kind: "user", id: newId(), text: event.text, sentAt }] };
    }

    case "text_delta": {
      const existing = state.streamingText.find((b) => b.index === event.index);
      const merged = { index: event.index, text: (existing?.text ?? "") + event.text };
      return { ...state, streamingText: [...state.streamingText.filter((b) => b.index !== event.index), merged] };
    }

    case "text": {
      // Synthetic marker the CLI itself inserts into the transcript when
      // interrupted (`[Request interrupted by user]`, `[...for tool use]`,
      // `[...by a plugin for tool use]`) — not real assistant content.
      // `turn_ended`'s `stopped` already covers this notice ("Interrompido
      // pelo usuário."), so committing this too would have duplicated the
      // message on screen.
      if (event.text.startsWith("[Request interrupted")) return state;
      // Unlike `user_message`'s synthetic timestamp, this one is a genuine
      // field the CLI itself stamps on every `assistant` stream-json line
      // (verified against real `claude -p --output-format stream-json`
      // output and the on-disk transcript, both live and replayed) — the
      // `Date.now()` fallback only covers an unexpected/older event shape.
      const sentAt = event.timestamp ? Date.parse(event.timestamp) : Date.now();
      return {
        ...state,
        entries: [...state.entries, { kind: "text", id: newId(), text: event.text, streaming: false, sentAt }],
        streamingText: [],
      };
    }

    case "tool_started":
      return {
        ...state,
        entries: [...state.entries, { kind: "tool-use", id: newId(), toolUseId: event.toolUseId, name: event.name, input: event.input }],
      };

    // TodoWrite's plan carries structured `todos` on the wire, but renders
    // through the exact same generic tool-use card as any other tool for
    // now (ToolCallCard's fallback branch already shows key/value pairs) —
    // a dedicated todo-list widget is future work, not required to close
    // out the wire-format debt this event exists to pay down.
    case "plan":
      return {
        ...state,
        entries: [...state.entries, { kind: "tool-use", id: newId(), toolUseId: event.toolUseId, name: "TodoWrite", input: { todos: event.todos } }],
      };

    case "tool_ended":
      return {
        ...state,
        entries: [
          ...state.entries,
          {
            kind: "tool-result",
            id: newId(),
            toolUseId: event.toolUseId,
            content: event.content,
            isError: event.isError,
            ...(event.structuredPatch ? { structuredPatch: event.structuredPatch } : {}),
          },
        ],
      };

    // Stopping mid-stream cuts off before the final `text` event that
    // normally commits the live preview into `entries` — without this the
    // partial text (which only existed in `streamingText`) would simply
    // vanish from the screen when the turn ends.
    case "turn_ended": {
      const entries = [...state.entries];
      for (const block of state.streamingText) {
        // No `timestamp` to fall back on here — this is a stop/interrupt
        // cutting the stream short, not a real `text` event.
        if (block.text.length > 0) entries.push({ kind: "text", id: newId(), text: block.text, streaming: false, sentAt: Date.now() });
      }
      if (event.stopped) entries.push({ kind: "stopped", id: newId() });
      return { ...state, entries, streamingText: [] };
    }

    case "error":
      return {
        ...state,
        entries: [...state.entries, { kind: "error", id: newId(), message: event.message }],
        streamingText: [],
      };
  }
}

function reducer(state: MessageLogState, action: Action): MessageLogState {
  switch (action.type) {
    case "USER_MESSAGE":
      return {
        ...state,
        entries: [...state.entries, { kind: "user", id: newId(), text: action.text, images: action.images, sentAt: action.sentAt }],
      };

    case "EDIT_USER_MESSAGE": {
      const index = state.entries.findIndex((entry) => entry.id === action.id);
      // Shouldn't happen (the id comes from an entry rendered right now),
      // but if the log changed under the user for some reason, treat it as
      // a normal send instead of risking truncating in the wrong place —
      // safer than silently cutting everything (`index: -1` would slice
      // the whole array).
      const base = index === -1 ? state.entries : state.entries.slice(0, index);
      return {
        ...state,
        entries: [...base, { kind: "user", id: newId(), text: action.text, sentAt: action.sentAt }],
        streamingText: [],
      };
    }

    case "AGENT_EVENT":
      return applyAgentEvent(state, action.event);

    case "TURN_ERROR":
      return applyAgentEvent(state, { type: "error", message: action.message });

    case "TURN_COMPLETE":
      return applyAgentEvent(state, { type: "turn_ended", stopped: action.stopped });

    // Reconnection — the relay resends the history
    // tail on every new connection, so the log needs to go back to empty
    // (including the pagination cursor/hasMore) to receive the hydration
    // without duplicating what was already on screen.
    case "RESET":
      return initialState;

    case "HYDRATE": {
      let next: MessageLogState = initialState;
      for (const message of action.messages) next = applyAgentEvent(next, message.event);
      return { ...next, hasMoreHistory: action.hasMore, historyCursor: action.cursor, loadingOlderHistory: false };
    }

    case "REQUEST_OLDER_HISTORY":
      return { ...state, loadingOlderHistory: true };

    case "PREPEND_HISTORY": {
      // Calculated from scratch (not from `state`): it's a page strictly
      // older than what's already on screen, processing it on top of the
      // current `state` would mix now's `streamingText` (live turn in
      // progress, if any) with content from the past — the resulting
      // `entries` goes in before what already exists, now's
      // `streamingText` stays untouched.
      let prefix: MessageLogState = initialState;
      for (const message of action.messages) prefix = applyAgentEvent(prefix, message.event);
      return {
        ...state,
        entries: [...prefix.entries, ...state.entries],
        hasMoreHistory: action.hasMore,
        historyCursor: action.cursor,
        loadingOlderHistory: false,
      };
    }

    default:
      return state;
  }
}

export interface UseMessageLogResult {
  entries: LogEntry[];
  streamingEntries: LogEntry[];
  /** Whether there are turns older than `historyCursor` to fetch —
   * UI uses this to know whether it still reacts to scrolling
   * to the top. */
  hasMoreHistory: boolean;
  /** `null` until the initial tail arrives (`hydrate`) — after that, it's
   * what gets sent to the relay via `loadOlderHistory(historyCursor)`. */
  historyCursor: number | null;
  /** Older-page request in flight — see `beginLoadingOlderHistory`. */
  loadingOlderHistory: boolean;
  addUserMessage: (text: string, images?: PendingAttachment[]) => void;
  /** Message editing — truncates locally (optimistically) up to
   * message `id` and pushes the new one on top. The relay client is the
   * one that actually sends `edit_message` to the relay; this here only
   * updates this device's screen, same pattern as
   * `addUserMessage`/`sendMessage` in `ChatPanel.onSend`. */
  editUserMessage: (id: string, text: string) => void;
  handleEvent: (event: AgentEvent) => void;
  handleTurnError: (message: string) => void;
  handleTurnComplete: (stopped?: boolean) => void;
  reset: () => void;
  /** Hydrates the log with the initial tail received via `history_page`
   * — called once per connection, in place of the old
   * event-by-event replay. */
  hydrate: (page: HistoryPageMessage) => void;
  /** Marks that a request for older turns is in flight — call before
   * firing `loadOlderHistory` on the relay (Phase 5, UI), avoids a
   * duplicate request while the response hasn't arrived yet. */
  beginLoadingOlderHistory: () => void;
  /** Inserts a `load_older_history` response at the start of the log. */
  prependHistory: (page: HistoryPageMessage) => void;
}

export function useMessageLog(): UseMessageLogResult {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Memoized on `state.streamingText`: without this, every render of the
  // consumer (e.g. ChatPanel's `turnInFlight` changing) would recreate this
  // array with new objects, breaking `React.memo`'s bail-out on log items.
  const streamingEntries: LogEntry[] = useMemo(
    () =>
      state.streamingText
        .filter((b) => b.text.length > 0)
        // `sentAt` here is a placeholder, never shown — the action strip
        // (Message.tsx::AssistantText) stays hidden while `streaming: true`,
        // it only reads `sentAt` once the block has actually committed.
        .map((b) => ({ kind: "text" as const, id: `streaming-${b.index}`, text: b.text, streaming: true, sentAt: Date.now() })),
    [state.streamingText],
  );

  return {
    entries: state.entries,
    streamingEntries,
    hasMoreHistory: state.hasMoreHistory,
    historyCursor: state.historyCursor,
    loadingOlderHistory: state.loadingOlderHistory,
    addUserMessage: (text, images) => dispatch({ type: "USER_MESSAGE", text, images, sentAt: Date.now() }),
    editUserMessage: (id, text) => dispatch({ type: "EDIT_USER_MESSAGE", id, text, sentAt: Date.now() }),
    handleEvent: (event) => dispatch({ type: "AGENT_EVENT", event }),
    handleTurnError: (message) => dispatch({ type: "TURN_ERROR", message }),
    handleTurnComplete: (stopped) => dispatch({ type: "TURN_COMPLETE", stopped: stopped === true }),
    reset: () => dispatch({ type: "RESET" }),
    hydrate: (page) => dispatch({ type: "HYDRATE", messages: page.messages, cursor: page.cursor, hasMore: page.hasMore }),
    beginLoadingOlderHistory: () => dispatch({ type: "REQUEST_OLDER_HISTORY" }),
    prependHistory: (page) =>
      dispatch({ type: "PREPEND_HISTORY", messages: page.messages, cursor: page.cursor, hasMore: page.hasMore }),
  };
}
