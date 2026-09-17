// Testa persistência de sessão: o nome da sessão aparece
// em GET /sessions assim que conecta (mesmo sem session_id ainda) e o
// session_id fica gravado em disco depois de um turno completar. Rodar do
// diretório `relay/`, com o relay já no ar (`npm run dev`, sem
// RELAY_SESSIONS_FILE definida — usa o fallback ./sessions.local.json):
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

console.log("[test] conectado, sessão:", SESSION_NAME);

const sessionsRightAfterConnect = await fetchSessions();
console.log("[test] /sessions logo após conectar:", sessionsRightAfterConnect.sessions);
if (!sessionsRightAfterConnect.sessions.includes(SESSION_NAME)) {
  throw new Error("nome da sessão deveria aparecer em /sessions assim que conecta, mesmo sem session_id ainda");
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
console.log("[test] session_id persistido em disco:", persistedId);
if (!persistedId) {
  throw new Error(`esperava um session_id persistido pra "${SESSION_NAME}", achei: ${JSON.stringify(persistedId)}`);
}

const sessionsAfterTurn = await fetchSessions();
if (!sessionsAfterTurn.sessions.includes(SESSION_NAME)) {
  throw new Error("nome da sessão sumiu de /sessions depois do turno");
}

console.log("[test] OK — persistência de sessão funcionando");
socket.close();
process.exit(0);
