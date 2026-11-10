// The `#` chips of a person's message against the real relay: the other
// devices get them on the live bubble, a device connecting later gets them
// on the replayed one — also after a relay restart, when the history is
// rebuilt from the agent's own transcript — and the agent's prompt never
// carries them. Claude through the fake `claude` (FAKE_CLAUDE_TRANSCRIPT).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import type { MessageTicketRef } from "../src/protocol/agent-event.js";
import { fakeJiraEnv, openRecorded } from "./helpers/fakeJira.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { isTurnEnded } from "./helpers/wsClient.js";

const work = mkdtempSync(join(tmpdir(), "anywh-ticket-refs-it-"));
const argvFile = join(work, "claude-argv.jsonl");
let env: Record<string, string>;
let relay: SpawnedServer | undefined;
const sockets: WebSocket[] = [];

const chip = (key: string, title?: string): MessageTicketRef => ({ provider: "jira", site: "acme.atlassian.net", key, ...(title ? { title } : {}) });

async function stop(): Promise<void> {
  for (const socket of sockets.splice(0)) socket.close();
  if (!relay) return;
  const current = relay;
  relay = undefined;
  current.proc.kill("SIGTERM");
  await current.waitForExit();
  current.cleanup();
}

before(async () => {
  env = { ...fakeJiraEnv(work), FAKE_CLAUDE_ARGV_FILE: argvFile, FAKE_CLAUDE_TRANSCRIPT: "1" };
  relay = await spawnRelay(env);
});

after(async () => {
  await stop();
  rmSync(work, { recursive: true, force: true });
});

async function session(id: string) {
  if (!relay) throw new Error("no relay");
  const opened = await openRecorded(relay.port, `/?session=${id}`);
  sockets.push(opened.socket);
  await opened.recorded.waitFor((message) => message.type === "caught_up");
  return opened;
}

async function send(chat: Awaited<ReturnType<typeof session>>, text: string, ticketRefs?: unknown): Promise<void> {
  const since = chat.recorded.mark();
  chat.socket.send(JSON.stringify({ type: "user_message", text, ...(ticketRefs ? { ticketRefs } : {}) }));
  await chat.recorded.waitFor(isTurnEnded, since, 15_000);
}

interface Bubble {
  text: string;
  ticketRefs?: MessageTicketRef[];
}

/** The user messages a device connecting now is replayed. */
async function bubbles(id: string): Promise<Bubble[]> {
  const chat = await session(id);
  const page = chat.recorded.messages.find((message) => message.type === "history_page") as { messages: { event: { type: string } & Bubble }[] } | undefined;
  chat.socket.close();
  return (page?.messages ?? []).map((entry) => entry.event).filter((event) => event.type === "user_message").map(({ text, ticketRefs }) => ({ text, ...(ticketRefs ? { ticketRefs } : {}) }));
}

function claudePrompts(): string[] {
  return readFileSync(argvFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] === "-p" && args[args.indexOf("--output-format") + 1] === "stream-json" && !args.includes("--input-format"))
    .map((args) => args[1]);
}

const expected: Bubble[] = [
  { text: "look at NGL-12 first", ticketRefs: [chip("NGL-12", "Fix the redirect")] },
  { text: "NGL-12 again, typed by hand" },
  // Same text twice: only the second one had a chip.
  { text: "ship NGL-7" },
  { text: "ship NGL-7", ticketRefs: [chip("NGL-7")] },
];

test("another device gets the chips on the live bubble; a message without any gets none; the agent sees only the text", async () => {
  const chat = await session("s-refs");
  const other = await session("s-refs");
  const since = other.recorded.mark();
  // A malformed ref and one whose key the text does not have are dropped.
  await send(chat, "look at NGL-12 first", [chip("NGL-12", "Fix the redirect"), { provider: "jira", key: "NGL-13" }, chip("NGL-99")]);
  await send(chat, "NGL-12 again, typed by hand");
  await send(chat, "ship NGL-7");
  await send(chat, "ship NGL-7", [chip("NGL-7")]);
  // The other device's copy of the last turn's end.
  let ended = since;
  for (let turn = 0; turn < expected.length; turn++) ended = other.recorded.messages.indexOf(await other.recorded.waitFor(isTurnEnded, ended)) + 1;
  const live = other.recorded.messages
    .slice(since)
    .filter((message) => message.type === "agent_event" && (message.event as { type: string }).type === "user_message")
    .map((message) => {
      const { text, ticketRefs } = message.event as Bubble;
      return { text, ...(ticketRefs ? { ticketRefs } : {}) };
    });
  assert.deepEqual(live, expected);
  assert.deepEqual(claudePrompts(), expected.map((bubble) => bubble.text));
});

test("a device connecting later gets them on the replayed bubbles", async () => {
  assert.deepEqual(await bubbles("s-refs"), expected);
});

test("after a relay restart the history rebuilt from the transcript carries them again", async () => {
  await stop();
  relay = await spawnRelay(env);
  assert.deepEqual(await bubbles("s-refs"), expected);
});
