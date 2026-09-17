// Testa: duas sessões nomeadas diferentes no mesmo relay têm conversas
// independentes, e o endpoint /sessions lista os nomes corretos.
import WebSocket from "ws";
import http from "node:http";

const PORT = 8765;

function connect(sessionName) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/?session=${sessionName}`);
  const events = [];
  socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
  return { socket, events };
}

function countTurnComplete(client) {
  return client.events.filter((m) => m.type === "agent_event" && m.event.type === "turn_ended").length;
}

async function waitForTurnCount(client, count, timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (countTurnComplete(client) >= count) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout esperando turno completar");
}

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

function lastResult(client) {
  const texts = client.events.filter((m) => m.type === "agent_event" && m.event.type === "text").map((m) => m.event.text);
  return texts[texts.length - 1];
}

const a = connect("projeto-a");
const b = connect("projeto-b");
await new Promise((resolve) => a.socket.on("open", resolve));
await new Promise((resolve) => b.socket.on("open", resolve));

console.log("[test] sessions logo após conectar:", (await fetchSessions()).sessions);

a.socket.send(JSON.stringify({ type: "user_message", text: "Minha cor e AZUL. So confirme, nao repita." }));
b.socket.send(JSON.stringify({ type: "user_message", text: "Minha cor e VERMELHO. So confirme, nao repita." }));
await waitForTurnCount(a, 1);
await waitForTurnCount(b, 1);

console.log("[test] perguntando a cor em cada sessão (devem responder diferente)");
a.socket.send(JSON.stringify({ type: "user_message", text: "Qual e minha cor? Responda so o nome da cor." }));
b.socket.send(JSON.stringify({ type: "user_message", text: "Qual e minha cor? Responda so o nome da cor." }));
await waitForTurnCount(a, 2);
await waitForTurnCount(b, 2);

console.log("[test] A (deveria mencionar AZUL):", lastResult(a));
console.log("[test] B (deveria mencionar VERMELHO):", lastResult(b));
console.log("[test] sessions no fim:", (await fetchSessions()).sessions);

a.socket.close();
b.socket.close();
process.exit(0);
