// Testa: (1) dois clientes conectados ao mesmo tempo recebem o mesmo turno
// ao vivo; (2) um terceiro cliente que conecta DEPOIS do turno terminar
// recebe o histórico via replay. Rodar com o relay já no ar.
import WebSocket from "ws";

const URL = "ws://127.0.0.1:8765";

function connect(name) {
  const socket = new WebSocket(URL);
  const events = [];
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    events.push(msg);
    if (msg.type === "agent_event" && msg.event.type === "text") {
      console.log(`[${name}] recebeu text:`, msg.event.text);
    }
  });
  return { socket, events, name };
}

async function waitFor(client, predicate, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (client.events.some(predicate)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`[${client.name}] timeout esperando evento`);
}

const isTurnComplete = (m) => m.type === "agent_event" && m.event.type === "turn_ended";

const a = connect("cliente-A");
const b = connect("cliente-B");

await new Promise((resolve) => a.socket.on("open", resolve));
await new Promise((resolve) => b.socket.on("open", resolve));
console.log("[test] A e B conectados, A manda o turno");

a.socket.send(JSON.stringify({ type: "user_message", text: "responda apenas: PONG" }));

await waitFor(a, isTurnComplete);
await waitFor(b, isTurnComplete);

console.log("--- checagem 1: A e B viram o mesmo turno ao vivo ---");
console.log("A recebeu eventos:", a.events.length > 0);
console.log("B recebeu eventos (sem ter mandado nada):", b.events.length > 0);

console.log("[test] conectando cliente-C agora (atrasado)");
const c = connect("cliente-C");
await new Promise((resolve) => c.socket.on("open", resolve));
await new Promise((r) => setTimeout(r, 500));

console.log("--- checagem 2: C recebeu histórico via replay ao conectar atrasado ---");
console.log("C recebeu eventos sem mandar nada:", c.events.length > 0);

a.socket.close();
b.socket.close();
c.socket.close();
process.exit(0);
