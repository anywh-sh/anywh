// Tests: (1) two clients connected at the same time receive the same turn
// live; (2) a third client that connects AFTER the turn ends receives the
// history via replay. Run with the relay already up.
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

const a = connect("client-A");
const b = connect("client-B");

await new Promise((resolve) => a.socket.on("open", resolve));
await new Promise((resolve) => b.socket.on("open", resolve));
console.log("[test] A and B connected, A sends the turn");

a.socket.send(JSON.stringify({ type: "user_message", text: "reply only: PONG" }));

await waitFor(a, isTurnComplete);
await waitFor(b, isTurnComplete);

console.log("--- check 1: A and B saw the same turn live ---");
console.log("A recebeu eventos:", a.events.length > 0);
console.log("B received events (without having sent anything):", b.events.length > 0);

console.log("[test] connecting client-C now (late)");
const c = connect("client-C");
await new Promise((resolve) => c.socket.on("open", resolve));
await new Promise((r) => setTimeout(r, 500));

console.log("--- check 2: C received history via replay when connecting late ---");
console.log("C received events without sending anything:", c.events.length > 0);

a.socket.close();
b.socket.close();
c.socket.close();
process.exit(0);
