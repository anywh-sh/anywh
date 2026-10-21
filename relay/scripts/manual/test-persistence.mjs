// Tests session persistence: the session name shows up in GET /sessions as
// soon as it connects (even without a session_id yet) and the session_id is
// written to disk after a turn completes. Run from the `relay/` directory
// with the relay already up (`npm run dev`, with RELAY_SESSIONS_FILE unset —
// it uses the ./sessions.local.json fallback):
// `node scripts/manual/test-persistence.mjs`.
import WebSocket from "ws";
import http from "node:http";
import { readFileSync } from "node:fs";

const PORT = 8765;
const SESSIONS_FILE = "./sessions.local.json";
const SESSION_NAME = `persist-test-${Date.now()}`;

function fetchSessions() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}/sessions`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(JSON.parse(body)));
      })
      .on("error", reject);
  });
}

const socket = new WebSocket(`ws://127.0.0.1:${PORT}/?session=${SESSION_NAME}`);
await new Promise((resolve, reject) => {
  socket.on("open", resolve);
  socket.on("error", reject);
});

console.log("[test] connected, session:", SESSION_NAME);

const sessionsRightAfterConnect = await fetchSessions();
console.log("[test] /sessions right after connecting:", sessionsRightAfterConnect.sessions);
if (!sessionsRightAfterConnect.sessions.includes(SESSION_NAME)) {
  throw new Error("the session name should show up in /sessions as soon as it connects, even without a session_id yet");
}

socket.send(JSON.stringify({ type: "user_message", text: "Diga apenas 'ok'." }));

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("timeout esperando turno completar")), 40000);
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "agent_event" && msg.event.type === "turn_ended") {
      clearTimeout(timeout);
      resolve();
    } else if (msg.type === "agent_event" && msg.event.type === "error") {
      clearTimeout(timeout);
      reject(new Error(`turno falhou: ${msg.event.message}`));
    }
  });
});

console.log("[test] turno completo");

const fileContent = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
const persistedId = fileContent[SESSION_NAME];
console.log("[test] session_id persisted on disk:", persistedId);
if (!persistedId) {
  throw new Error(`expected a persisted session_id for "${SESSION_NAME}", found: ${JSON.stringify(persistedId)}`);
}

const sessionsAfterTurn = await fetchSessions();
if (!sessionsAfterTurn.sessions.includes(SESSION_NAME)) {
  throw new Error("the session name disappeared from /sessions after the turn");
}

console.log("[test] OK — session persistence working");
socket.close();
process.exit(0);
