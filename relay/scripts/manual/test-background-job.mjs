// Testa: o follow-up automático de anywh-bg ponta-a-ponta contra um relay de verdade (`npm run
// dev` rodando em outro terminal) — pede pro Claude rodar um comando via
// `anywh-bg`, espera o primeiro turno responder "iniciei", e confirma que
// um SEGUNDO turno chega sozinho (sem nenhuma mensagem nova do cliente)
// quando o job termina, com o resultado certo e marcado como sintético.
import WebSocket from "ws";

const PORT = 8765;
const marker = `fase-d-${Date.now()}`;

function connect(sessionName) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/?session=${sessionName}`);
  const events = [];
  socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
  return { socket, events };
}

function countTurnComplete(client) {
  return client.events.filter((m) => m.type === "agent_event" && m.event.type === "turn_ended").length;
}

async function waitForTurnCount(client, count, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (countTurnComplete(client) >= count) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout esperando ${count} turno(s) completar(em) (visto ${countTurnComplete(client)})`);
}

function lastResultText(client) {
  const texts = client.events.filter((m) => m.type === "agent_event" && m.event.type === "text").map((m) => m.event.text);
  return texts[texts.length - 1];
}

function userPrompts(client) {
  return client.events.filter((m) => m.type === "agent_event" && m.event.type === "user_message").map((m) => m.event);
}

const client = connect(`test-bg-job-${Date.now()}`);
await new Promise((resolve) => client.socket.on("open", resolve));

console.log("[test] pedindo pra rodar um job em background via anywh-bg");
client.socket.send(
  JSON.stringify({
    type: "user_message",
    text:
      `Rode em background via anywh-bg (não espere terminar): sleep 6 && echo "${marker}". ` +
      "Só confirme que iniciou, numa frase curta.",
  }),
);
await waitForTurnCount(client, 1, 30_000);
console.log("[test] primeiro turno (deveria dizer que iniciou, sem prometer aviso):", lastResultText(client));

console.log("[test] esperando o turno de follow-up automático chegar sozinho (job de 6s + poll de até 10s)...");
await waitForTurnCount(client, 2, 45_000);

const prompts = userPrompts(client);
const synthetic = prompts.find((p) => p.synthetic === "background_job");
if (!synthetic) {
  console.error("[test] FALHOU: nenhum user_message sintético (synthetic: background_job) encontrado");
  process.exit(1);
}
console.log("[test] user_message sintético recebido, label:", synthetic.label);

const secondResult = lastResultText(client);
console.log("[test] segundo turno (deveria reportar o resultado do job):", secondResult);

if (!secondResult || !secondResult.includes(marker)) {
  console.error(`[test] FALHOU: resposta do follow-up não menciona o marcador único "${marker}"`);
  process.exit(1);
}

console.log("[test] OK — turno de follow-up chegou sozinho, marcado como sintético, e reportou o resultado certo");
client.socket.close();
process.exit(0);
