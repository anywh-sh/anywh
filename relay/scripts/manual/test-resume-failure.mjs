// Testa o caso real que quebrou pro usuário: um --resume de session_id
// inválido deve virar um erro claro (não silêncio) E resetar o sessionId
// interno pra próxima tentativa começar do zero em vez de repetir o erro.
import { ClaudeSession } from "../../dist/runtimes/defs/claude/session.js";

const session = new ClaudeSession();
// Força um session_id inválido, simulando o que aconteceu de verdade
// (sessão órfã depois da troca de cópia por symlink das credenciais).
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
console.log("lançou erro:", threw);
console.log("mensagem:", errorMessage);
console.log("sessionId resetado:", session["sessionId"] === undefined);

console.log("\n--- tentativa seguinte deve funcionar (sessão nova) ---");
let secondOk = false;
await session.sendTurn("responda apenas: OK", (event) => {
  if (event.type === "result" && !event.is_error) secondOk = true;
});
console.log("segunda tentativa funcionou:", secondOk);
console.log("novo sessionId válido:", typeof session["sessionId"] === "string");
