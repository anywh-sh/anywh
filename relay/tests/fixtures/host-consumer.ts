// A stand-in for the relay's side of an agent subscription, run as its own
// process so a test can kill it by pid the way a relay restart would: the
// real `HostClient`, subscribed to one agent, appending every event it is
// handed to a file. It derives its starting cursor from the last line of that
// same file — what it durably processed is what it resumes after, which is
// the contract a real consumer of `HostClient` follows.
//
//   HOST_SOCKET=<path> AGENT_ID=<id> OUT=<file> node --import tsx host-consumer.ts
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { HostClient, START_OF_LOG, type AgentCursor } from "../../src/agentHost/hostClient.js";

const socketPath = process.env.HOST_SOCKET!;
const agentId = process.env.AGENT_ID!;
const out = process.env.OUT!;

let cursor: AgentCursor = START_OF_LOG;
if (existsSync(out)) {
  const last = readFileSync(out, "utf8").trimEnd().split("\n").at(-1);
  if (last) {
    const record = JSON.parse(last) as { seq: number; next: number };
    cursor = { nextOffset: record.next, lastSeq: record.seq };
  }
}

const client = new HostClient({ socketPath, clientName: "test-consumer", reconnectMinMs: 20, reconnectMaxMs: 200 });
client.start();
client.subscribe(agentId, cursor, {
  onEvent: (event) => {
    appendFileSync(out, `${JSON.stringify({ seq: event.seq, off: event.off, next: event.next, type: event.ev.type, subtype: event.ev.subtype ?? null })}\n`);
  },
  onCaughtUp: (nextOffset) => console.log(`caught_up ${nextOffset}`),
});
