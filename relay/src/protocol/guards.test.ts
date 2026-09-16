import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isUserMessage,
  isStopTurnMessage,
  isEditMessageMessage,
  isClearConversationMessage,
  isSetCwdMessage,
  isSetPermissionModeMessage,
  isSetModelMessage,
  isSetDraftMessage,
  isRenameBody,
  isIdBody,
  isCreateProfileBody,
  isPatchProfileBody,
  isFilesCreateBody,
  isFilesDeleteBody,
  isFilesRenameBody,
  isTerminalCloseBody,
  isTerminalInputMessage,
  isLoadOlderHistoryMessage,
  isCancelBackgroundJobMessage,
  isChoiceAnswerMessage,
  isTerminalResizeMessage,
  isWatchMessage,
  isTerminalScrollMessage,
} from "./guards.js";

// Every guard here is the validation surface for a WS message or an HTTP
// JSON body — these tests pin down *today's* acceptance behavior (this is
// the characterization stage of an Extract -> Test -> Refactor move, not a
// spec of what a guard should accept). Three non-object shapes exercised
// per guard (`null`, a bare string, an array) rather than every JS
// falsy/truthy value — that's the shape every one of these guards actually
// branches on (`typeof value === "object" && value !== null`).
const NON_OBJECTS = [null, "not an object", []] as const;

test("isUserMessage", () => {
  assert.equal(isUserMessage({ type: "user_message", text: "hi" }), true);
  assert.equal(isUserMessage({ type: "user_message" }), false, "missing text");
  assert.equal(isUserMessage({ type: "user_message", text: 5 }), false, "wrong type for text");
  assert.equal(isUserMessage({ type: "other", text: "hi" }), false, "wrong type discriminator");
  for (const v of NON_OBJECTS) assert.equal(isUserMessage(v), false);
});

test("isStopTurnMessage", () => {
  assert.equal(isStopTurnMessage({ type: "stop_turn" }), true);
  assert.equal(isStopTurnMessage({ type: "other" }), false);
  for (const v of NON_OBJECTS) assert.equal(isStopTurnMessage(v), false);
});

test("isEditMessageMessage", () => {
  assert.equal(isEditMessageMessage({ type: "edit_message", fromEnd: 1, text: "hi" }), true);
  assert.equal(isEditMessageMessage({ type: "edit_message", text: "hi" }), false, "missing fromEnd");
  assert.equal(isEditMessageMessage({ type: "edit_message", fromEnd: 1 }), false, "missing text");
  assert.equal(isEditMessageMessage({ type: "edit_message", fromEnd: "1", text: "hi" }), false, "wrong type for fromEnd");
  assert.equal(isEditMessageMessage({ type: "edit_message", fromEnd: 1, text: 5 }), false, "wrong type for text");
  for (const v of NON_OBJECTS) assert.equal(isEditMessageMessage(v), false);
});

test("isClearConversationMessage", () => {
  assert.equal(isClearConversationMessage({ type: "clear_conversation" }), true);
  assert.equal(isClearConversationMessage({ type: "other" }), false);
  for (const v of NON_OBJECTS) assert.equal(isClearConversationMessage(v), false);
});

test("isSetCwdMessage", () => {
  assert.equal(isSetCwdMessage({ type: "set_cwd", path: "/tmp" }), true);
  assert.equal(isSetCwdMessage({ type: "set_cwd" }), false, "missing path");
  assert.equal(isSetCwdMessage({ type: "set_cwd", path: 5 }), false, "wrong type for path");
  for (const v of NON_OBJECTS) assert.equal(isSetCwdMessage(v), false);
});

test("isSetPermissionModeMessage", () => {
  for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"]) {
    assert.equal(isSetPermissionModeMessage({ type: "set_permission_mode", mode }), true, mode);
  }
  assert.equal(isSetPermissionModeMessage({ type: "set_permission_mode" }), false, "missing mode");
  assert.equal(isSetPermissionModeMessage({ type: "set_permission_mode", mode: "not_a_mode" }), false, "unknown mode value");
  for (const v of NON_OBJECTS) assert.equal(isSetPermissionModeMessage(v), false);
});

test("isSetModelMessage", () => {
  assert.equal(isSetModelMessage({ type: "set_model", model: "sonnet" }), true);
  assert.equal(isSetModelMessage({ type: "set_model" }), false, "missing model");
  assert.equal(isSetModelMessage({ type: "set_model", model: "" }), false, "empty model string");
  assert.equal(isSetModelMessage({ type: "set_model", model: 5 }), false, "wrong type for model");
  for (const v of NON_OBJECTS) assert.equal(isSetModelMessage(v), false);
});

test("isSetDraftMessage", () => {
  assert.equal(isSetDraftMessage({ type: "set_draft", draft: "wip" }), true);
  assert.equal(isSetDraftMessage({ type: "set_draft", draft: "" }), true, "empty draft is still a string");
  assert.equal(isSetDraftMessage({ type: "set_draft" }), false, "missing draft");
  assert.equal(isSetDraftMessage({ type: "set_draft", draft: 5 }), false, "wrong type for draft");
  for (const v of NON_OBJECTS) assert.equal(isSetDraftMessage(v), false);
});

test("isRenameBody", () => {
  assert.equal(isRenameBody({ id: "s1", title: "New title" }), true);
  assert.equal(isRenameBody({ title: "New title" }), false, "missing id");
  assert.equal(isRenameBody({ id: "s1" }), false, "missing title");
  assert.equal(isRenameBody({ id: 5, title: "New title" }), false, "wrong type for id");
  for (const v of NON_OBJECTS) assert.equal(isRenameBody(v), false);
});

test("isIdBody", () => {
  assert.equal(isIdBody({ id: "s1" }), true);
  assert.equal(isIdBody({}), false, "missing id");
  assert.equal(isIdBody({ id: 5 }), false, "wrong type for id");
  for (const v of NON_OBJECTS) assert.equal(isIdBody(v), false);
});

test("isCreateProfileBody", () => {
  assert.equal(isCreateProfileBody({ label: "Work" }), true);
  assert.equal(isCreateProfileBody({ label: "Work", home: "/home/work" }), true, "optional home present");
  assert.equal(isCreateProfileBody({}), false, "missing label");
  assert.equal(isCreateProfileBody({ label: "  " }), false, "label is whitespace-only");
  assert.equal(isCreateProfileBody({ label: 5 }), false, "wrong type for label");
  assert.equal(isCreateProfileBody({ label: "Work", home: 5 }), false, "wrong type for optional home");
  for (const v of NON_OBJECTS) assert.equal(isCreateProfileBody(v), false);
});

test("isPatchProfileBody", () => {
  assert.equal(isPatchProfileBody({ label: "Renamed" }), true, "label alone");
  assert.equal(isPatchProfileBody({ colorIndex: 2 }), true, "colorIndex alone");
  assert.equal(isPatchProfileBody({ themeId: "dark" }), true, "themeId alone");
  assert.equal(isPatchProfileBody({ themeId: null }), true, "null themeId clears the selection, a meaningful value");
  assert.equal(isPatchProfileBody({}), false, "no field present at all");
  assert.equal(isPatchProfileBody({ label: 5 }), false, "wrong type for label");
  assert.equal(isPatchProfileBody({ colorIndex: "2" }), false, "wrong type for colorIndex");
  assert.equal(isPatchProfileBody({ themeId: 5 }), false, "wrong type for themeId");
  for (const v of NON_OBJECTS) assert.equal(isPatchProfileBody(v), false);
});

test("isFilesCreateBody", () => {
  assert.equal(isFilesCreateBody({ name: "new-file.txt" }), true);
  assert.equal(isFilesCreateBody({ name: "new-file.txt", dir: "sub" }), true, "optional dir present");
  assert.equal(isFilesCreateBody({ name: "new-file.txt", dir: null }), true, "null dir means the root");
  assert.equal(isFilesCreateBody({}), false, "missing name");
  assert.equal(isFilesCreateBody({ name: 5 }), false, "wrong type for name");
  assert.equal(isFilesCreateBody({ name: "new-file.txt", dir: 5 }), false, "wrong type for optional dir");
  for (const v of NON_OBJECTS) assert.equal(isFilesCreateBody(v), false);
});

test("isFilesDeleteBody", () => {
  assert.equal(isFilesDeleteBody({ path: "a.txt" }), true);
  assert.equal(isFilesDeleteBody({}), false, "missing path");
  assert.equal(isFilesDeleteBody({ path: 5 }), false, "wrong type for path");
  for (const v of NON_OBJECTS) assert.equal(isFilesDeleteBody(v), false);
});

test("isFilesRenameBody", () => {
  assert.equal(isFilesRenameBody({ path: "a.txt", newName: "b.txt" }), true);
  assert.equal(isFilesRenameBody({ newName: "b.txt" }), false, "missing path");
  assert.equal(isFilesRenameBody({ path: "a.txt" }), false, "missing newName");
  assert.equal(isFilesRenameBody({ path: 5, newName: "b.txt" }), false, "wrong type for path");
  for (const v of NON_OBJECTS) assert.equal(isFilesRenameBody(v), false);
});

test("isTerminalCloseBody", () => {
  assert.equal(isTerminalCloseBody({ session: "s1", term: "t1" }), true);
  assert.equal(isTerminalCloseBody({ term: "t1" }), false, "missing session");
  assert.equal(isTerminalCloseBody({ session: "s1" }), false, "missing term");
  assert.equal(isTerminalCloseBody({ session: 5, term: "t1" }), false, "wrong type for session");
  for (const v of NON_OBJECTS) assert.equal(isTerminalCloseBody(v), false);
});

test("isTerminalInputMessage", () => {
  assert.equal(isTerminalInputMessage({ type: "input", data: "ls\n" }), true);
  assert.equal(isTerminalInputMessage({ type: "input" }), false, "missing data");
  assert.equal(isTerminalInputMessage({ type: "input", data: 5 }), false, "wrong type for data");
  for (const v of NON_OBJECTS) assert.equal(isTerminalInputMessage(v), false);
});

test("isLoadOlderHistoryMessage", () => {
  assert.equal(isLoadOlderHistoryMessage({ type: "load_older_history", beforeCursor: 10 }), true);
  assert.equal(isLoadOlderHistoryMessage({ type: "load_older_history" }), false, "missing beforeCursor");
  assert.equal(isLoadOlderHistoryMessage({ type: "load_older_history", beforeCursor: "10" }), false, "wrong type for beforeCursor");
  for (const v of NON_OBJECTS) assert.equal(isLoadOlderHistoryMessage(v), false);
});

test("isCancelBackgroundJobMessage", () => {
  assert.equal(isCancelBackgroundJobMessage({ type: "cancel_background_job", id: "job-1" }), true);
  assert.equal(isCancelBackgroundJobMessage({ type: "cancel_background_job" }), false, "missing id");
  assert.equal(isCancelBackgroundJobMessage({ type: "cancel_background_job", id: 5 }), false, "wrong type for id");
  for (const v of NON_OBJECTS) assert.equal(isCancelBackgroundJobMessage(v), false);
});

test("isChoiceAnswerMessage", () => {
  assert.equal(isChoiceAnswerMessage({ type: "choice_answer", promptId: "p1", answers: [] }), true);
  assert.equal(isChoiceAnswerMessage({ type: "choice_answer", answers: [] }), false, "missing promptId");
  assert.equal(isChoiceAnswerMessage({ type: "choice_answer", promptId: "p1" }), false, "missing answers");
  assert.equal(isChoiceAnswerMessage({ type: "choice_answer", promptId: "p1", answers: "not-an-array" }), false, "wrong type for answers");
  for (const v of NON_OBJECTS) assert.equal(isChoiceAnswerMessage(v), false);
});

test("isTerminalResizeMessage", () => {
  assert.equal(isTerminalResizeMessage({ type: "resize", cols: 80, rows: 24 }), true);
  assert.equal(isTerminalResizeMessage({ type: "resize", cols: 0, rows: 24 }), false, "cols must be > 0");
  assert.equal(isTerminalResizeMessage({ type: "resize", cols: 80, rows: 0 }), false, "rows must be > 0");
  assert.equal(isTerminalResizeMessage({ type: "resize", cols: "80", rows: 24 }), false, "wrong type for cols");
  assert.equal(isTerminalResizeMessage({ type: "other", cols: 80, rows: 24 }), false, "wrong type discriminator");
  for (const v of NON_OBJECTS) assert.equal(isTerminalResizeMessage(v), false);
});

test("isWatchMessage", () => {
  assert.equal(isWatchMessage({ type: "watch", dirs: ["a"], files: ["b.txt"] }), true);
  assert.equal(isWatchMessage({ type: "watch", dirs: [], files: [] }), true, "empty arrays are valid — no watches");
  assert.equal(isWatchMessage({ type: "watch", files: [] }), false, "missing dirs");
  assert.equal(isWatchMessage({ type: "watch", dirs: [] }), false, "missing files");
  assert.equal(isWatchMessage({ type: "watch", dirs: [5], files: [] }), false, "non-string entry in dirs");
  assert.equal(isWatchMessage({ type: "watch", dirs: [], files: [5] }), false, "non-string entry in files");
  for (const v of NON_OBJECTS) assert.equal(isWatchMessage(v), false);
});

test("isTerminalScrollMessage", () => {
  assert.equal(isTerminalScrollMessage({ type: "scroll", lines: 3 }), true);
  assert.equal(isTerminalScrollMessage({ type: "scroll", lines: -3 }), true, "negative lines scrolls down");
  assert.equal(isTerminalScrollMessage({ type: "scroll" }), false, "missing lines");
  assert.equal(isTerminalScrollMessage({ type: "scroll", lines: "3" }), false, "wrong type for lines");
  for (const v of NON_OBJECTS) assert.equal(isTerminalScrollMessage(v), false);
});
