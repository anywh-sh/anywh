// Tests the real case that broke for a user: a --resume with an invalid
// session_id must become a clear error (not silence) AND reset the internal
// sessionId so the next attempt starts from scratch instead of repeating the
// error.
import { ClaudeSession } from "../../dist/runtimes/defs/claude/session.js";

const session = new ClaudeSession();
// Forces an invalid session_id, simulating what really happened (an orphan
// session after the credentials switched from a copy to a symlink).
session["sessionId"] = "00000000-0000-0000-0000-000000000000";

let threw = false;
let errorMessage = "";
try {
  await session.sendTurn("oi", () => {});
} catch (error) {
  threw = true;
  errorMessage = error.message;
}

console.log("--- resultado ---");
console.log("threw an error:", threw);
console.log("mensagem:", errorMessage);
console.log("sessionId resetado:", session["sessionId"] === undefined);

console.log("\n--- next attempt should work (new session) ---");
let secondOk = false;
await session.sendTurn("responda apenas: OK", (event) => {
  if (event.type === "result" && !event.is_error) secondOk = true;
});
console.log("segunda tentativa funcionou:", secondOk);
console.log("new sessionId valid:", typeof session["sessionId"] === "string");
