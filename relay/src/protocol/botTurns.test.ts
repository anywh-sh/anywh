import { test } from "node:test";
import assert from "node:assert/strict";
import { botTurnKind } from "./botTurns.js";

test("a bot's relay turns are told apart from what the person typed, with their label", () => {
  assert.deepEqual(botTurnKind('[anywh-bot] Schedule "Daily summary" fired.\n\nDo it.'), { kind: "bot_schedule", label: "Daily summary" });
  assert.deepEqual(botTurnKind("[anywh-bot] The person answered your question on task #13.\n\nQuestion: q\nAnswer: a"), { kind: "bot_note", label: "answer:13" });
  assert.deepEqual(botTurnKind("[anywh-bot] You were just created. Start your first conversation."), { kind: "bot_note", label: "created" });
  assert.equal(botTurnKind("please [anywh-bot] check"), undefined);
});

test("a message that only starts like the relay's is the person's own", () => {
  assert.equal(botTurnKind("[anywh-bot] hello from me"), undefined);
});
