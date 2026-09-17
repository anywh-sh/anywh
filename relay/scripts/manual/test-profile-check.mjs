// Confirms each relay runs with the right isolated $HOME/cwd, by reading the
// `cwd_state` message the relay sends right on connection.
// Usage: node test-profile-check.mjs <host> <port> [label]
import WebSocket from "ws";

const host = process.argv[2];
const port = process.argv[3];
const label = process.argv[4] ?? `porta ${port}`;
if (!host || !port) {
  console.error("Uso: node test-profile-check.mjs <host> <porta> [label]");
  process.exit(1);
}
const socket = new WebSocket(`ws://${host}:${port}`);

socket.on("open", () => {
  socket.send(JSON.stringify({ type: "user_message", text: "responda apenas: OK" }));
});

socket.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "cwd_state") {
    console.log(`[${label}] cwd da sessão:`, msg.cwd);
  }
  if (msg.type === "agent_event" && msg.event.type === "turn_ended") {
    process.exit(0);
  }
  if (msg.type === "agent_event" && msg.event.type === "error") {
    console.error(`[${label}] erro:`, msg.event.message);
    process.exit(1);
  }
});

setTimeout(() => {
  console.error(`[${label}] timeout`);
  process.exit(1);
}, 30000);
