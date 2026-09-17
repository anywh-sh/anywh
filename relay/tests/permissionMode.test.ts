import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSessionAndCollectUntil } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): `set_permission_mode`
// with a mode id this session's def doesn't offer, driven over the real
// WebSocket protocol. `SharedSession.setPermissionMode` (session/permissionModes.ts)
// validates against the def's own `permissions.modesFor` now, instead of a
// fixed union that `protocol/guards.ts`'s wire guard used to enforce — this
// is the behavior that moved, characterized end-to-end.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

test("set_permission_mode with an id the session's def doesn't offer re-broadcasts the CURRENT mode, not the rejected one", async () => {
  const { socket, messages: burst } = await connectSessionAndCollectUntil(server.port, "session-bad-mode", (message) => message.type === "caught_up");
  const initialMode = burst.find((message) => message.type === "permission_mode_state");
  assert.equal(initialMode?.mode, "bypassPermissions", "Claude's default mode before any selection");

  socket.send(JSON.stringify({ type: "set_permission_mode", mode: "not_a_real_mode" }));

  const [rebroadcast] = await collectUntil(socket, (message) => message.type === "permission_mode_state");
  assert.equal(rebroadcast.mode, "bypassPermissions", "an unknown mode must snap back to the current one, not be accepted");

  socket.close();
});
