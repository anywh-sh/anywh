import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { RoomChannel, type RoomStateSource } from "./roomChannel.js";
import { summarizeRoom, type RoomAgentView, type RoomSnapshot } from "./roomState.js";

const agent = (id: string, state: RoomAgentView["state"]): RoomAgentView => ({
  agentId: id, role: "worker", title: id, runtime: "claude", model: null, createdBy: "agent", state, queuedMessages: 0, needsYou: [], subtasksRunning: 0,
});

/** A real WebSocket server with the channel behind it, and a source the test edits. */
async function setup(): Promise<{ agents: Map<string, RoomAgentView>; channel: RoomChannel; connect: () => Promise<{ socket: WebSocket; messages: Record<string, unknown>[] }>; close: () => void }> {
  const agents = new Map<string, RoomAgentView>();
  const source: RoomStateSource = {
    snapshot: (roomId): RoomSnapshot | undefined => {
      if (roomId !== "r") return undefined;
      const list = [...agents.values()];
      return { roomId, agents: list, summary: summarizeRoom(list) };
    },
  };
  const channel = new RoomChannel(source, 5);
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (socket) => {
    channel.watch("r", socket);
    socket.on("close", () => channel.unwatch("r", socket));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    agents,
    channel,
    connect: () =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
        const messages: Record<string, unknown>[] = [];
        socket.on("message", (raw: Buffer) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
        socket.once("open", () => resolve({ socket, messages }));
        socket.once("error", reject);
      }),
    close: () => {
      wss.close();
      http.close();
    },
  };
}

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("a watcher gets the whole room first, then only what changed, in a few messages", async () => {
  const room = await setup();
  try {
    for (let i = 0; i < 10; i++) room.agents.set(`w${i}`, agent(`w${i}`, "working"));
    const { socket, messages } = await room.connect();
    await until(() => messages.length >= 1);
    assert.equal(messages[0].type, "room_snapshot");
    assert.equal((messages[0].agents as unknown[]).length, 10, "ten agents on one channel");

    // All ten finish at once: one message each plus the summary, and nothing for an agent that did not change.
    for (let i = 0; i < 10; i++) room.agents.set(`w${i}`, agent(`w${i}`, "done"));
    room.agents.set("w9", agent("w9", "working"));
    for (let i = 0; i < 10; i++) room.channel.touch("r");
    await until(() => messages.some((m) => m.type === "room_summary"));
    await new Promise((r) => setTimeout(r, 50));
    const updates = messages.slice(1);
    assert.deepEqual(updates.filter((m) => m.type === "room_agent_state").map((m) => (m.agent as RoomAgentView).agentId).sort(), ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"]);
    assert.equal(updates.filter((m) => m.type === "room_summary").length, 1, "touches in a burst are one flush");
    assert.equal((updates.find((m) => m.type === "room_summary")!.summary as { counts: { done: number } }).counts.done, 9);

    room.agents.delete("w0");
    room.channel.touch("r");
    await until(() => messages.some((m) => m.type === "room_agent_removed" && m.agentId === "w0"));
    socket.close();
  } finally {
    room.close();
  }
});

test("a second watcher gets a snapshot of the room as it is now and is not sent old changes again", async () => {
  const room = await setup();
  try {
    room.agents.set("a", agent("a", "working"));
    const first = await room.connect();
    await until(() => first.messages.length >= 1);
    room.agents.set("a", agent("a", "done"));
    room.channel.touch("r");
    await until(() => first.messages.some((m) => m.type === "room_agent_state"));
    const second = await room.connect();
    await until(() => second.messages.length >= 1);
    assert.equal(((second.messages[0].agents as RoomAgentView[])[0]).state, "done");
    room.channel.touch("r");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(second.messages.length, 1, "nothing changed, nothing sent");
    first.socket.close();
    second.socket.close();
  } finally {
    room.close();
  }
});
