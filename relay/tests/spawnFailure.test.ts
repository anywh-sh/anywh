import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

function isAgentError(message: Record<string, unknown>): boolean {
  return message.type === "agent_event" && (message.event as { type?: string } | undefined)?.type === "error";
}

// Real integration test (.anywh/skills/tests/SKILL.md): boots the actual
// relay server, talks to it over a real WebSocket, only fakes the `claude`
// process. Reproduces a real incident (2026-09-08): a tab's working
// directory was moved/deleted out from under it (repo relocated, `mv` +
// forgot to update the session), so the next message's `spawn(AGENT_BIN,
// args, { cwd })` fails with ENOENT — and, before the fix, that took the
// *entire relay process* down (all profiles, all tabs), not just that one
// turn. `testServer.ts`'s own comment about "nonexistent cwd → ENOENT
// blamed on the child, not a clearly-labeled bad-cwd error" documents the
// same trap from the other side (why the default test homeDir must exist).

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

test("cwd removed out from under a locked session: an agent_event error, not a dead server", async () => {
  const goneDir = join(server.homeDir, "moved-away");
  mkdirSync(goneDir, { recursive: true });

  const victim = await connectSession(server.port, "session-victim");
  victim.send(JSON.stringify({ type: "set_cwd", path: goneDir }));
  await collectUntil(victim, (message) => message.type === "cwd_state" && message.cwd === goneDir);

  // Simulates the repo move that caused the real incident: the directory a
  // tab's cwd was already locked to (implicitly, on the next real turn)
  // stops existing.
  rmSync(goneDir, { recursive: true, force: true });

  sendUserMessage(victim, "hello");
  const messages = await collectUntil(victim, isAgentError);
  const turnError = messages.find(isAgentError);
  assert.ok(turnError, `expected an agent_event error, got: ${JSON.stringify(messages)}`);
  victim.close();

  // The real assertion: the crash blast radius. A single tab's stale cwd
  // must not take the whole relay down — a fresh session on a still-valid
  // cwd must complete normally right after.
  const control = await connectSession(server.port, "session-control");
  sendUserMessage(control, "hello");
  const controlMessages = await collectUntil(control, isTurnEnded);
  assert.deepEqual(controlMessages.at(-1), { type: "agent_event", event: { type: "turn_ended", stopped: false } });
  control.close();
});
