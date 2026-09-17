import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/session/sessionStore.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, connectSessionAndCollectUntil, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): the prompt-draft
// feature (composer content not yet sent, persisted per session so it
// survives a relay restart or a reconnect from another tab/device) driven
// over the real WebSocket protocol and the real sessions file on disk —
// same shape as sessionLifecycle.test.ts's disk-persistence check.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

test("a draft is broadcast on set_draft, sent to a fresh connection to the same session, and survives a reload from disk", async () => {
  const draftText = "rascunho ainda não enviado";
  const socket = await connectSession(server.port, "session-draft");
  socket.send(JSON.stringify({ type: "set_draft", draft: draftText }));

  const messages = await collectUntil(socket, (message) => message.type === "draft_state" && message.draft === draftText);
  assert.equal(messages.at(-1)!.draft, draftText);
  socket.close();

  // A second connection to the SAME session — not the one that set the
  // draft — must see it immediately on connect (SharedSession.addClient's
  // `sendDraftState`), before any history or turn ever happens on this
  // socket. This is the actual "another tab picks up your draft" flow. Uses
  // `connectSessionAndCollectUntil`, not `connectSession` + `collectUntil`
  // separately — see that helper's doc comment for the real race the
  // two-step version has with a connection-time burst like this one.
  const { socket: secondSocket, messages: secondMessages } = await connectSessionAndCollectUntil(
    server.port,
    "session-draft",
    (message) => message.type === "draft_state",
  );
  assert.equal(secondMessages.at(-1)!.draft, draftText);

  const reloaded = new SessionStore(process.env.RELAY_SESSIONS_FILE!, server.homeDir);
  assert.equal(reloaded.getDraft("session-draft"), draftText, "the draft should be persisted to disk, not just in-memory");

  secondSocket.close();
});

test("submitting a turn does not clear the session's stored draft", async () => {
  const draftText = "outro rascunho, ainda digitando em outra aba";
  const socket = await connectSession(server.port, "session-draft-2");
  socket.send(JSON.stringify({ type: "set_draft", draft: draftText }));
  await collectUntil(socket, (message) => message.type === "draft_state" && message.draft === draftText);

  // A real turn completing is unrelated to the draft — only an explicit
  // `set_draft` (composer cleared client-side after a real send, or by the
  // user themselves) should ever change it. A relay that auto-cleared the
  // draft on any turn would break the "another device is still typing its
  // own message" case this feature exists for.
  sendUserMessage(socket, "mensagem enviada normalmente, sem relação com o rascunho");
  await collectUntil(socket, isTurnEnded);

  const reloaded = new SessionStore(process.env.RELAY_SESSIONS_FILE!, server.homeDir);
  assert.equal(reloaded.getDraft("session-draft-2"), draftText);

  socket.close();
});
