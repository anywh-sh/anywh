// Manual relay test client — connects, sends 2 turns, confirms that the
// session_id is kept across them (real context continuity).
// Run from the `relay/` directory with the relay already up (`npm run dev`):
// `node scripts/manual/test-client.mjs`.
import WebSocket from "ws";

const socket = new WebSocket("ws://127.0.0.1:8765");

function send(text) {
  socket.send(JSON.stringify({ type: "user_message", text }));
}

let turn = 0;
const sessionIdsSeen = [];

socket.on("open", () => {
  console.log("[test] connected, sending turn 1");
  turn = 1;
  send("My favorite color is anywh-green. Just confirm you noted it, do not repeat it.");
});

socket.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type !== "agent_event") return;
  const event = msg.event;
  if (event.type === "text") {
    console.log(`[test] turn ${turn} text:`, event.text);
  } else if (event.type === "session_id") {
    sessionIdsSeen[turn - 1] = event.sessionId;
    console.log(`[test] turn ${turn} session_id:`, event.sessionId);
  } else if (event.type === "turn_ended") {
    console.log(`[test] turn ${turn} complete`);
    if (turn === 1) {
      turn = 2;
      console.log("[test] sending turn 2 (testing continuity through the relay)");
      send("What is my favorite color?");
    } else {
      console.log("--- resultado final ---");
      console.log("turnos completados:", sessionIdsSeen.length);
      console.log("session_id manteve entre turnos:", sessionIdsSeen[0] === sessionIdsSeen[1]);
      socket.close();
      process.exit(0);
    }
  }
});

socket.on("error", (err) => {
  console.error("[test] error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("[test] timeout — algo travou");
  process.exit(1);
}, 60000);
