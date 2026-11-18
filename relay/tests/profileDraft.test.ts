import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// A profile created from the app: a draft reserves its id and config root,
// its agent is checked there, and creating it runs the real add-profile.sh
// --config-root (systemctl is the fake, as in every integration test).

let server: TestServer;

before(async () => {
  // Nothing answers for a profile the fake systemctl "started"; don't wait for it.
  process.env.ANYWH_RELAY_READY_TIMEOUT = "1";
  server = await startTestServer();
  // add-profile.sh copies the advertised host from an existing profile.
  writeFileSync(join(server.envDir, "existing.env"), "RELAY_PORT=9998\nRELAY_HOST=192.0.2.10\n");
});

after(async () => {
  await server.close();
});

const url = (path: string): string => `http://127.0.0.1:${server.port}${path}`;
const post = (path: string, body: unknown): Promise<Response> => fetch(url(path), { method: "POST", body: JSON.stringify(body) });

test("a draft reserves an id and a private config root; a second draft of the same name gets its own", async () => {
  const first = (await (await post("/control/profiles/draft", { label: "Side Work" })).json()) as { id: string };
  const second = (await (await post("/control/profiles/draft", { label: "Side Work" })).json()) as { id: string };
  assert.equal(first.id, "side-work");
  assert.equal(second.id, "side-work-2");
  const root = join(server.profilesDir, first.id);
  for (const sub of ["claude", "codex", "kimi", "rooms"]) assert.ok(statSync(join(root, sub)).isDirectory(), sub);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal((await post("/control/profiles/draft", { label: "  " })).status, 400);

  // Walking away drops it, signed-in accounts included.
  assert.equal((await fetch(url(`/control/profiles/draft/${second.id}`), { method: "DELETE" })).status, 200);
  assert.equal(existsSync(join(server.profilesDir, second.id)), false);
  assert.equal((await fetch(url(`/control/profiles/draft/${second.id}`), { method: "DELETE" })).status, 404);
});

test("validating and creating from a draft use its config folders, and the profile keeps the real $HOME", async () => {
  const draft = (await (await post("/control/profiles/draft", { label: "Client X" })).json()) as { id: string };

  const validated = (await (await post("/control/profiles/validate", { draftId: draft.id })).json()) as { loggedIn: boolean; collidesWith?: string };
  assert.equal(validated.loggedIn, true);
  // Its own folders are nobody else's accounts, unlike the real $HOME's.
  assert.equal(validated.collidesWith, undefined);
  assert.equal((await post("/control/profiles/validate", { draftId: "missing" })).status, 404);

  const created = await post("/control/profiles", { label: "Client X", draftId: draft.id });
  assert.equal(created.status, 200, await created.clone().text());
  assert.equal(((await created.json()) as { id: string }).id, draft.id);

  const env = readFileSync(join(server.envDir, `${draft.id}.env`), "utf8");
  const root = join(server.profilesDir, draft.id);
  assert.match(env, new RegExp(`^CLAUDE_CONFIG_DIR=${root}/claude$`, "m"));
  assert.match(env, new RegExp(`^RELAY_ROOM_CONTEXT_DIR=${root}/rooms$`, "m"));
  assert.doesNotMatch(env, /^RELAY_HOME_OVERRIDE=/m);

  // It is a profile now, not a draft: the draft routes leave it alone, and
  // a second profile can't take the same folders.
  assert.equal((await fetch(url(`/control/profiles/draft/${draft.id}`), { method: "DELETE" })).status, 404);
  assert.equal((await post("/control/profiles", { label: "Again", draftId: draft.id })).status, 404);
});

test("a body naming a draft and a home at once is refused", async () => {
  assert.equal((await post("/control/profiles", { label: "Both", draftId: "x", home: "/tmp/x" })).status, 400);
});

test("creating with shared categories links the machine's own config and keeps Claude's MCP servers through the .env", async () => {
  // The machine's $HOME, for the relay's homedir() and the script alike.
  const machineHome = mkdtempSync(join(tmpdir(), "anywh-machine-home-"));
  mkdirSync(join(machineHome, ".claude"), { recursive: true });
  writeFileSync(join(machineHome, ".claude", "CLAUDE.md"), "be terse");
  writeFileSync(join(machineHome, ".claude.json"), JSON.stringify({ mcpServers: { sentry: { command: "s" } } }));
  const savedHome = process.env.HOME;
  process.env.HOME = machineHome;
  try {
    const draft = (await (await post("/control/profiles/draft", { label: "Shared bits" })).json()) as { id: string };
    const created = await post("/control/profiles", {
      label: "Shared bits",
      draftId: draft.id,
      sharing: { instructions: "shared", preferences: "separate", mcp: "shared" },
    });
    assert.equal(created.status, 200, await created.clone().text());
    const root = join(server.profilesDir, draft.id);
    assert.equal(readlinkSync(join(root, "claude", "CLAUDE.md")), join(machineHome, ".claude", "CLAUDE.md"));
    assert.equal(existsSync(join(root, "claude", "settings.json")), false, "preferences stayed separate");
    const env = readFileSync(join(server.envDir, `${draft.id}.env`), "utf8");
    assert.match(env, new RegExp(`^ANYWH_CLAUDE_SHARED_MCP=${join(machineHome, ".claude.json")}$`, "m"));
    assert.equal((await post("/control/profiles", { label: "Bad", sharing: { instructions: "everything" } })).status, 400);
  } finally {
    process.env.HOME = savedHome;
    rmSync(machineHome, { recursive: true, force: true });
  }
});
