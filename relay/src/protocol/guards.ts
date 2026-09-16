import type { ModelChoice, PermissionMode } from "../session/sessionStore.js";
import type { ChoiceAnswer } from "../bridges/mcpBridge.js";

interface UserMessage {
  type: "user_message";
  text: string;
}

export function isUserMessage(value: unknown): value is UserMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "user_message" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

export function isStopTurnMessage(value: unknown): value is { type: "stop_turn" } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "stop_turn";
}

/** Message edit — `fromEnd` counts from the end (`1` = the
 * user's last message). */
export function isEditMessageMessage(value: unknown): value is { type: "edit_message"; fromEnd: number; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "edit_message" &&
    typeof (value as { fromEnd?: unknown }).fromEnd === "number" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

export function isClearConversationMessage(value: unknown): value is { type: "clear_conversation" } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "clear_conversation";
}

export function isSetCwdMessage(value: unknown): value is { type: "set_cwd"; path: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "set_cwd" &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export function isSetPermissionModeMessage(value: unknown): value is { type: "set_permission_mode"; mode: PermissionMode } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "set_permission_mode" &&
    PERMISSION_MODES.includes((value as { mode?: unknown }).mode as PermissionMode)
  );
}

// No fixed enum here on purpose — the model catalog is now whatever the
// CLI's own `/model` probe reports (defaultModel.ts), which can grow without
// a relay change. A garbage value just makes the CLI itself reject the turn
// with its own error, same reasoning as the composer's `/model` parsing
// (client/src/lib/slashCommands.ts).
export function isSetModelMessage(value: unknown): value is { type: "set_model"; model: ModelChoice } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "set_model" &&
    typeof (value as { model?: unknown }).model === "string" &&
    (value as { model: string }).model.length > 0
  );
}

export function isSetDraftMessage(value: unknown): value is { type: "set_draft"; draft: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "set_draft" &&
    typeof (value as { draft?: unknown }).draft === "string"
  );
}

export function isRenameBody(value: unknown): value is { id: string; title: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { title?: unknown }).title === "string"
  );
}

export function isIdBody(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

export function isCreateProfileBody(value: unknown): value is { label: string; home?: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { label?: unknown; home?: unknown };
  return (
    typeof candidate.label === "string" &&
    candidate.label.trim().length > 0 &&
    (candidate.home === undefined || typeof candidate.home === "string")
  );
}

/** `themeId: null` is a meaningful value here (clear the selection, back to
 * the built-in theme), so it can't be folded into "field absent". */
export function isPatchProfileBody(value: unknown): value is { label?: string; colorIndex?: number; themeId?: string | null } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { label?: unknown; colorIndex?: unknown; themeId?: unknown };
  if (candidate.label !== undefined && typeof candidate.label !== "string") return false;
  if (candidate.colorIndex !== undefined && typeof candidate.colorIndex !== "number") return false;
  if (candidate.themeId !== undefined && candidate.themeId !== null && typeof candidate.themeId !== "string") return false;
  return candidate.label !== undefined || candidate.colorIndex !== undefined || candidate.themeId !== undefined;
}

export function isFilesCreateBody(value: unknown): value is { session?: string; dir?: string | null; name: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; dir?: unknown };
  return typeof candidate.name === "string" && (candidate.dir === undefined || candidate.dir === null || typeof candidate.dir === "string");
}

export function isFilesDeleteBody(value: unknown): value is { session?: string; path: string } {
  return typeof value === "object" && value !== null && typeof (value as { path?: unknown }).path === "string";
}

export function isFilesRenameBody(value: unknown): value is { session?: string; path: string; newName: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { newName?: unknown }).newName === "string"
  );
}

export function isTerminalCloseBody(value: unknown): value is { session: string; term: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { session?: unknown }).session === "string" &&
    typeof (value as { term?: unknown }).term === "string"
  );
}

export function isTerminalInputMessage(value: unknown): value is { type: "input"; data: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "input" &&
    typeof (value as { data?: unknown }).data === "string"
  );
}

/** Paginated history — request for turns older than the
 * initial tail, triggered by the user scrolling up in the UI. */
export function isLoadOlderHistoryMessage(value: unknown): value is { type: "load_older_history"; beforeCursor: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "load_older_history" &&
    typeof (value as { beforeCursor?: unknown }).beforeCursor === "number"
  );
}

/** Cancellation of an `anywh-bg` job requested by the UI. */
export function isCancelBackgroundJobMessage(value: unknown): value is { type: "cancel_background_job"; id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "cancel_background_job" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

export function isChoiceAnswerMessage(value: unknown): value is { type: "choice_answer"; promptId: string; answers: ChoiceAnswer[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "choice_answer" &&
    typeof (value as { promptId?: unknown }).promptId === "string" &&
    Array.isArray((value as { answers?: unknown }).answers)
  );
}

export function isTerminalResizeMessage(value: unknown): value is { type: "resize"; cols: number; rows: number } {
  if (typeof value !== "object" || value === null || (value as { type?: unknown }).type !== "resize") return false;
  const cols = (value as { cols?: unknown }).cols;
  const rows = (value as { rows?: unknown }).rows;
  return typeof cols === "number" && cols > 0 && typeof rows === "number" && rows > 0;
}

/** Work dir file panel's watch — always the client's full
 * current set of visible dirs/files, never an incremental add/remove (see
 * `FilesWatchSession`). */
export function isWatchMessage(value: unknown): value is { type: "watch"; dirs: string[]; files: string[] } {
  if (typeof value !== "object" || value === null || (value as { type?: unknown }).type !== "watch") return false;
  const dirs = (value as { dirs?: unknown }).dirs;
  const files = (value as { files?: unknown }).files;
  return Array.isArray(dirs) && dirs.every((d) => typeof d === "string") && Array.isArray(files) && files.every((f) => typeof f === "string");
}

export function isTerminalScrollMessage(value: unknown): value is { type: "scroll"; lines: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "scroll" &&
    typeof (value as { lines?: unknown }).lines === "number"
  );
}
