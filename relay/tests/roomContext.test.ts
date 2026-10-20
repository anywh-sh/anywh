// A room's context across real processes: the relay's HTTP routes for the
// room's folder, the index handed to each agent in its spawn (read off the
// argv the agent host gave the fake `claude`), the notice for items that
// arrive after an agent was born, and the folder's cleanup.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { hostEnvDir, startHostProcess, type HostProcess } from "./helpers/agentHostProcess.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

let host: HostProcess;
let relay: SpawnedServer;
let base: string;
let contextRoot: string;
const argvFile = (): string => join(host.dir, "argv.jsonl");

before(async () => {
  const { dir, home } = hostEnvDir();
  host = startHostProcess(dir, home, { FAKE_CLAUDE_ARGV_FILE: join(dir, "argv.jsonl") });
  contextRoot = mkdtempSync(join(tmpdir(), "anywh-ctx-root-"));
  relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_ROOM_CONTEXT_DIR: contextRoot });
  base = `http://127.0.0.1:${relay.port}`;
  await waitFor(async () => (await fetch(`${base}/agents/activity`)).status === 200, 20_000, "relay connected to the host");
});

after(async () => {
  relay?.cleanup();
  await host?.stop();
  if (host) rmSync(host.dir, { recursive: true, force: true });
  rmSync(contextRoot, { recursive: true, force: true });
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${relay?.output.join("").slice(-3000) ?? ""}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const marker = (tool: string, args: unknown): string => `[[room:${tool}:${Buffer.from(JSON.stringify(args)).toString("base64url")}]]`;

async function createRoom(): Promise<string> {
  const res = await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", cwd: host.dir, title: "Context room" }) });
  assert.equal(res.status, 201);
  return ((await res.json()) as { roomId: string }).roomId;
}

async function addItem(roomId: string, name: string, body: string): Promise<Response> {
  return fetch(`${base}/rooms/${roomId}/context?name=${encodeURIComponent(name)}`, { method: "POST", body });
}

async function turn(socket: WebSocket, text: string): Promise<string> {
  const done = collectUntil(socket, isTurnEnded, 30_000);
  sendUserMessage(socket, text);
  const events = (await done).filter((m) => m.type === "agent_event").map((m) => m.event as Record<string, unknown>);
  return events.filter((e) => e.type === "text").map((e) => String(e.text)).join("\n");
}

function spawns(): string[][] {
  return readFileSync(argvFile(), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}
const flag = (args: string[], name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test("an attachment is a file in the room's folder, listed in the index the principal is born with; the folder is granted with --add-dir", async () => {
  const roomId = await createRoom();
  const added = await addItem(roomId, "brief.md", "# Checkout redesign\nMake the cart faster.\n");
  assert.equal(added.status, 201);
  const listing = (await (await fetch(`${base}/rooms/${roomId}/context`)).json()) as { dir: string; items: { name: string }[]; index: string };
  assert.equal(listing.dir, join(contextRoot, roomId));
  assert.deepEqual(listing.items.map((i) => i.name), ["brief.md"]);
  assert.equal(readFileSync(join(listing.dir, "brief.md"), "utf8"), "# Checkout redesign\nMake the cart faster.\n");

  const socket = await connectSession(relay.port, roomId);
  try {
    await turn(socket, "hello");
    const principal = spawns().find((args) => flag(args, "--append-system-prompt")?.includes(`\`brief.md\` · text · 2 lines · user · Checkout redesign`));
    assert.ok(principal, "the principal's system prompt carries the index");
    const prompt = flag(principal, "--append-system-prompt")!;
    assert.ok(prompt.startsWith("You are the principal agent of an anywh room"));
    assert.ok(prompt.length < 6000 + 3000, "the index stays small");
    assert.equal(flag(principal, "--add-dir"), listing.dir);
  } finally {
    socket.close();
  }
});

test("an item that arrives after an agent was born is announced once, in a message; removing one updates the index", async () => {
  const roomId = await createRoom();
  const socket = await connectSession(relay.port, roomId);
  try {
    const first = await turn(socket, "first");
    assert.doesNotMatch(first, /New in the room's context/);
    assert.equal((await addItem(roomId, "late.md", "# Late arrival\nbody\n")).status, 201);
    const second = await turn(socket, "second");
    assert.match(second, /\[anywh-note\] New in the room's context since you started: `late\.md` · text · 2 lines · user · Late arrival/);
    const third = await turn(socket, "third");
    assert.doesNotMatch(third, /New in the room's context/, "told once");

    const gone = await fetch(`${base}/rooms/${roomId}/context/late.md`, { method: "DELETE" });
    assert.equal(gone.status, 200);
    assert.equal(existsSync(join(contextRoot, roomId, "late.md")), false);
    const listing = (await (await fetch(`${base}/rooms/${roomId}/context`)).json()) as { index: string };
    assert.doesNotMatch(listing.index, /late\.md/);
    assert.equal((await fetch(`${base}/rooms/${roomId}/context/late.md`, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(`${base}/rooms/nope/context`)).status, 404);
    assert.equal((await addItem(roomId, "INDEX.md", "x")).status, 400);
  } finally {
    socket.close();
  }
});

test("workers born with the same index get byte-identical system prompts; a result file they list joins the index under their name", async () => {
  const roomId = await createRoom();
  await addItem(roomId, "notes.md", "# Shared notes\n");
  const socket = await connectSession(relay.port, roomId);
  try {
    const dir = join(contextRoot, roomId);
    // The file an agent wrote into the folder before reporting it.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result-a.md"), "# Findings of A\nthree\n");
    const report = marker("report", { status: "done", summary: "wrote it", artifacts: [join(dir, "result-a.md")] });
    await turn(socket, `${marker("delegate", { task: `Worker alpha ${report}`, runtime: "claude", model: "haiku" })} ${marker("delegate", { task: "Worker beta", runtime: "claude", model: "haiku" })}`);
    await waitFor(() => spawns().filter((args) => flag(args, "--append-system-prompt")?.startsWith("You are an agent of an anywh room") && flag(args, "--append-system-prompt")?.includes(dir)).length >= 2, 20_000, "both workers' spawns");
    const prompts = spawns()
      .map((args) => flag(args, "--append-system-prompt"))
      .filter((prompt): prompt is string => prompt?.startsWith("You are an agent of an anywh room") === true && prompt.includes(dir));
    assert.equal(prompts[0], prompts[1], "siblings share their whole prompt, so the model's cache of it");
    assert.match(prompts[0], /`notes\.md` · text · 1 line · user · Shared notes/);
    assert.ok(prompts[0].indexOf("Never edit INDEX.md") < prompts[0].indexOf("# Room context"), "fixed text first, then the index");

    type Listing = { items: { name: string; author: string; summary: string }[] };
    const result = async (): Promise<Listing["items"][number] | undefined> => ((await (await fetch(`${base}/rooms/${roomId}/context`)).json()) as Listing).items.find((item) => item.name === "result-a.md");
    await waitFor(async () => (await result())?.author.startsWith("Worker alpha") === true, 20_000, "the result credited to its worker");
    const found = (await result())!;
    assert.equal(found.summary, "Findings of A");
  } finally {
    socket.close();
  }
});

test("deleting a room removes its folder", async () => {
  const roomId = await createRoom();
  await addItem(roomId, "x.md", "x\n");
  assert.ok(existsSync(join(contextRoot, roomId)));
  const del = await fetch(`${base}/sessions/delete`, { method: "POST", body: JSON.stringify({ id: roomId }) });
  assert.equal(del.status, 200, await del.clone().text());
  assert.equal(existsSync(join(contextRoot, roomId)), false);
});

test("a restart removes the folders of rooms that no longer exist, keeps the live ones, and touches nothing when the sessions file is unreadable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-ctx-restart-"));
  const root = join(dir, "ctx");
  const sessionsFile = join(dir, "profile.json");
  const entry = { agentId: "claude", sessionId: {}, title: "Room", cwd: { cwd: "/tmp", locked: false }, lastActiveAt: Date.now(), room: { roomId: "live-room", role: "principal", createdBy: "user", task: "", undeliveredReports: [] } };
  writeFileSync(sessionsFile, JSON.stringify({ "live-room": entry }));
  for (const room of ["live-room", "gone-room"]) {
    mkdirSync(join(root, room), { recursive: true });
    writeFileSync(join(root, room, "f.md"), "f");
  }
  let proc = await spawnRelay({ RELAY_SESSIONS_FILE: sessionsFile, RELAY_ROOM_CONTEXT_DIR: root });
  try {
    assert.equal(existsSync(join(root, "gone-room")), false, "the orphan folder is gone");
    assert.equal(existsSync(join(root, "live-room", "f.md")), true, "the live room's folder stays");
    proc.proc.kill("SIGTERM");
    await proc.waitForExit();
    proc.cleanup();
    mkdirSync(join(root, "other-room"), { recursive: true });
    writeFileSync(sessionsFile, "{ not json");
    proc = await spawnRelay({ RELAY_SESSIONS_FILE: sessionsFile, RELAY_ROOM_CONTEXT_DIR: root });
    assert.equal(existsSync(join(root, "other-room")), true, "an unreadable sessions file must not make every room look gone");
    assert.equal(existsSync(join(root, "live-room", "f.md")), true);
  } finally {
    proc.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
