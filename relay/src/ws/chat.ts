import type { WebSocket } from "ws";
import { shuttingDown } from "../lifecycle.js";
import {
  isCancelBackgroundJobMessage,
  isChoiceAnswerMessage,
  isClearConversationMessage,
  isEditMessageMessage,
  isLoadOlderHistoryMessage,
  isSetCwdMessage,
  isSetDraftMessage,
  isSetModelMessage,
  isSetPermissionModeMessage,
  isStopTurnMessage,
  isUserMessage,
} from "../protocol/guards.js";
import type { EditMessageError, SharedSession } from "../session/sharedSession.js";

/** The chat WS connection's `message` dispatch — the 10 message types a
 * connected client can send once it's attached to a `SharedSession`
 * (terminal/files/sessions-watch connections have their own, simpler
 * protocols, see ws/terminal.ts, ws/files.ts). */
export function dispatchChatMessage(session: SharedSession, socket: WebSocket, parsed: unknown): void {
  if (isStopTurnMessage(parsed)) {
    session.stopTurn();
    return;
  }
  if (isClearConversationMessage(parsed)) {
    session.clearConversation();
    return;
  }
  if (isSetCwdMessage(parsed)) {
    const result = session.setCwd(parsed.path);
    if (!result.ok) socket.send(JSON.stringify({ type: "set_cwd_error", code: result.error }));
    return;
  }
  if (isSetPermissionModeMessage(parsed)) {
    session.setPermissionMode(parsed.mode);
    return;
  }
  if (isSetModelMessage(parsed)) {
    session.setModel(parsed.model);
    return;
  }
  if (isSetDraftMessage(parsed)) {
    session.setDraft(parsed.draft);
    return;
  }
  if (isLoadOlderHistoryMessage(parsed)) {
    session.loadOlderHistory(socket, parsed.beforeCursor);
    return;
  }
  if (isChoiceAnswerMessage(parsed)) {
    session.answerChoice(parsed.promptId, parsed.answers);
    return;
  }
  if (isCancelBackgroundJobMessage(parsed)) {
    session.cancelBackgroundJob(parsed.id);
    return;
  }
  if (isEditMessageMessage(parsed)) {
    if (shuttingDown) {
      socket.send(JSON.stringify({ type: "edit_message_error", code: "relay_restarting" satisfies EditMessageError }));
      return;
    }
    session.editMessage(socket, parsed.fromEnd, parsed.text);
    return;
  }
  if (!isUserMessage(parsed)) {
    console.warn("[relay] message ignored, unexpected format:", parsed);
    return;
  }
  if (shuttingDown) {
    socket.send(
      JSON.stringify({ type: "agent_event", event: { type: "error", message: "relay reiniciando, tente de novo em instantes" } }),
    );
    return;
  }
  session.submitTurn(socket, parsed.text);
}
