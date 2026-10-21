import { useCallback, useMemo, useReducer } from "react";
import type { AgentEvent, HistoryPageMessage } from "@/lib/relay/relayClient";
import type { UseRelayClientOptions } from "@/hooks/relay/useRelayClient";
import { applyReplyEvent, emptyReply, replyFromHistory, type AgentReply } from "@/lib/sala/agentReply";

type Action =
  | { type: "event"; event: AgentEvent }
  | { type: "history"; page: HistoryPageMessage }
  | { type: "running"; active: boolean }
  | { type: "reset" };

function reduce(state: AgentReply, action: Action): AgentReply {
  switch (action.type) {
    case "event":
      return applyReplyEvent(state, action.event);
    case "history": {
      const replayed = replyFromHistory(action.page.messages);
      return {
        ...replayed,
        // A turn in flight is also announced on its own, which may land first.
        running: replayed.running || state.running,
        // The page is a tail: older turns exist, so this is not the first one.
        turns: action.page.hasMore ? Math.max(replayed.turns, 2) : replayed.turns,
      };
    }
    case "running":
      return state.running === action.active ? state : { ...state, running: action.active };
    case "reset":
      return emptyReply;
  }
}

/**
 * The latest reply of the agent behind a session, fed by the callbacks of the
 * panel's own `useRelayClient` connection (spread `handlers` into its
 * options): this hook opens no socket, so the panel keeps exactly one.
 */
export function useAgentReply(): { reply: AgentReply; handlers: Pick<UseRelayClientOptions, "onEvent" | "onTurnComplete" | "onTurnError" | "onHistoryPage" | "onHistoryTruncated" | "onReconnecting" | "onConversationReset" | "onTurnState"> } {
  const [reply, dispatch] = useReducer(reduce, emptyReply);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);
  const handlers = useMemo(
    () => ({
      onEvent: (event: AgentEvent) => dispatch({ type: "event", event }),
      onTurnComplete: (stopped: boolean, durationMs?: number) =>
        dispatch({ type: "event", event: { type: "turn_ended", stopped, ...(durationMs !== undefined ? { durationMs } : {}) } }),
      onTurnError: (message: string) => dispatch({ type: "event", event: { type: "error", message } }),
      // The relay replays the history from the start after a reconnection.
      onReconnecting: reset,
      onConversationReset: reset,
      onHistoryPage: (page: HistoryPageMessage) => dispatch({ type: "history", page }),
      onHistoryTruncated: (page: HistoryPageMessage) => dispatch({ type: "history", page }),
      // The session's own word on a turn in flight, which a replay can miss.
      onTurnState: (state: { active: boolean }) => dispatch({ type: "running", active: state.active }),
    }),
    [reset],
  );
  return { reply, handlers };
}
