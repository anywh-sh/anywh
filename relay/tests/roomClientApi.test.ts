// What the room's screen needs beyond the channel, end to end: a first
// message sent with the room, an agent the person starts, the clock and the
// connectors of an agent, the worktrees listing and the "discard anyway" gate
// of a removal. Real relay, real agent host, fake `claude`, real git.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { hostEnvDir, startHostProcess, type HostProcess } from "./helpers/agentHostProcess.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { connectSessionAndCollectUntil } from "./helpers/wsClient.js";

let host: HostProcess;
let relay: SpawnedServer;
let base: string;

before(async () => {
  const { dir, home } = hostEnvDir();
  host = startHostProcess(dir, home);
  relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, RELAY_WORKTREES_ROOT: join(dir, "worktrees"), RELAY_ROOM_REMOVE_UNDO_MS: "1500" });
  base = `http://127.0.0.1:${relay.port}`;
  await waitFor(async () => (await fetch(`${base}/agents/activity`)).status === 200, "relay connected to the host");
});

after(async () => {
  relay?.cleanup();
  await host?.stop();
  if (host) rmSync(host.dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await Promise.resolve(check()).catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${relay?.output.join("").slice(-2000) ?? ""}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const marker = (tool: string, args: unknown): string => `[[room:${tool}:${b64(args)}]]`;

interface AgentView {
  agentId: string;
  role: string;
  createdBy: string;
  state: string;
  startedAt?: number;
  connectors: string[];
  report?: { status: string };
}

/** The agents of a room as its channel sends them on connecting. */
async function agentsOf(roomId: string): Promise<Map<string, AgentView>> {
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/rooms/${roomId}/watch`);
  try {
    return await new Promise((resolve, reject) => {
      socket.on("message", (data: Buffer) => {
        const message = JSON.parse(data.toString()) as { type: string; agents?: AgentView[] };
        if (message.type === "room_snapshot") resolve(new Map(message.agents!.map((agent) => [agent.agentId, agent])));
      });
      socket.on("error", reject);
    });
  } finally {
    socket.close();
  }
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

test("a first message sent with the room reaches the principal, and a person's agent runs with its clock and connectors", async () => {
  assert.equal((await post("/rooms", { agentId: "claude", firstMessage: "  " })).status, 400, "an empty first message is refused");
  const created = await post("/rooms", { agentId: "claude", model: "haiku", cwd: host.dir, firstMessage: "hello principal" });
  assert.equal(created.status, 201);
  const { roomId } = (await created.json()) as { roomId: string };
  await waitFor(async () => (await agentsOf(roomId)).get(roomId)?.startedAt !== undefined, "the principal's turn to start");
  const { messages } = await connectSessionAndCollectUntil(relay.port, roomId, (message) => message.type === "caught_up", 20_000);
  assert.match(JSON.stringify(messages), /hello principal/, "the message is in the principal's conversation");

  const mcp = `[[ask:${b64({ tool: "mcp__figma__get_node", input: {} })}]]`;
  assert.equal((await post(`/rooms/${roomId}/agents`, { task: "" })).status, 400);
  assert.equal((await post(`/rooms/nope/agents`, { task: "x" })).status, 404);
  const started = await post(`/rooms/${roomId}/agents`, { task: `look at the design ${mcp}` });
  assert.equal(started.status, 201, await started.clone().text());
  const { agentId } = (await started.json()) as { agentId: string };

  await waitFor(async () => {
    const agent = (await agentsOf(roomId)).get(agentId);
    return agent?.startedAt !== undefined && agent.connectors.includes("figma");
  }, "the agent's clock and its connector");
  const agent = (await agentsOf(roomId)).get(agentId)!;
  assert.equal(agent.createdBy, "user");
  assert.deepEqual(agent.connectors, ["figma"], "only the person's connectors are listed, never the relay's own bridges");
  assert.ok(Date.now() - agent.startedAt! < 60_000);
});

test("removing an agent with work that is not integrated waits for the person to discard it; the worktrees are listed with their size", async () => {
  const repo = join(host.dir, "repo-rm");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const created = await post("/rooms", { agentId: "claude", model: "haiku", cwd: repo });
  const { roomId } = (await created.json()) as { roomId: string };
  const empty = (await (await fetch(`${base}/rooms/${roomId}/worktrees`)).json()) as { worktrees: unknown[]; totalSizeBytes: number };
  assert.deepEqual(empty, { worktrees: [], totalSizeBytes: 0 });
  assert.equal((await fetch(`${base}/rooms/nope/worktrees`)).status, 404);

  const started = await post(`/rooms/${roomId}/agents`, { task: `edit ${marker("worktree_create", { repo: "." })} ${marker("report", { status: "done", summary: "edited", artifacts: [] })}` });
  const { agentId } = (await started.json()) as { agentId: string };
  await waitFor(async () => (await agentsOf(roomId)).get(agentId)?.report?.status === "done", "the agent's report");
  const branch = git(repo, "branch", "--format=%(refname:short)").split("\n").find((name) => name.startsWith("anywh/"))!;
  const path = git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .find((line) => line.startsWith(`worktree ${join(host.dir, "worktrees")}`))!
    .slice("worktree ".length);
  writeFileSync(join(path, "change.txt"), "work\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "work");

  const trees = (await (await fetch(`${base}/rooms/${roomId}/worktrees`)).json()) as { worktrees: { agentId: string; branch: string; integrated: boolean; sizeBytes?: number }[]; totalSizeBytes: number };
  assert.equal(trees.worktrees.length, 1);
  assert.equal(trees.worktrees[0].agentId, agentId);
  assert.equal(trees.worktrees[0].integrated, false);
  assert.ok((trees.worktrees[0].sizeBytes ?? 0) > 0);
  assert.equal(trees.totalSizeBytes, trees.worktrees[0].sizeBytes);

  const refused = await post(`/rooms/${roomId}/agents/${agentId}/remove`);
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { needsDiscard: boolean; worktrees: { branch: string }[] };
  assert.equal(body.needsDiscard, true);
  assert.equal(body.worktrees[0].branch, branch);
  assert.ok((await agentsOf(roomId)).has(agentId), "nothing was removed");
  assert.ok(git(repo, "branch", "--format=%(refname:short)").includes(branch));

  const removed = await post(`/rooms/${roomId}/agents/${agentId}/remove`, { discard: true });
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.ok(!(await agentsOf(roomId)).has(agentId), "hidden at once");
  await waitFor(() => !git(repo, "branch", "--format=%(refname:short)").includes(branch), "the discarded branch to go once the undo window is over");
  assert.equal(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
});
