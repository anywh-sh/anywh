import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addRoomContextFile, createRoom, fetchRoomCanvas, fetchRoomContextCount, parseRoomChannelMessage, removeRoomAgent, saveRoomCanvas, stopRoomAgent } from "@/lib/relay/roomClient";
import type { Profile } from "@/lib/profiles/profiles";

const profile: Profile = { id: "p", label: "P", host: "10.0.0.5", relayPort: 8765, connectToken: "secret" };

let calls: { url: string; init?: RequestInit }[];
function reply(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }),
  );
}

beforeEach(() => {
  calls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("room HTTP calls", () => {
  it("opens a room with what was picked, as JSON, with the connection's token", async () => {
    reply(201, { roomId: "r1" });
    await expect(createRoom(profile, { agentId: "claude", model: "opus", effort: "high", cwd: "/work", title: "T" })).resolves.toBe("r1");
    expect(calls[0].url).toBe("http://10.0.0.5:8765/rooms");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ agentId: "claude", model: "opus", effort: "high", cwd: "/work", title: "T" });
    expect(JSON.stringify(calls[0].init?.headers)).toContain("Bearer secret");
  });

  it("raises the relay's own words when a room cannot be opened", async () => {
    reply(400, { error: "cwd must be an existing absolute directory" });
    await expect(createRoom(profile, { cwd: "/nope" })).rejects.toThrow("cwd must be an existing absolute directory");
  });

  it("escapes a room id into the path", async () => {
    reply(200, { canvas: { positions: {}, areas: [], texts: [] } });
    await fetchRoomCanvas(profile, "a/b c");
    expect(calls[0].url).toBe("http://10.0.0.5:8765/rooms/a%2Fb%20c/canvas");
  });

  it("reads a room that is gone as null, not as an error", async () => {
    reply(404, { error: "room not found" });
    await expect(fetchRoomCanvas(profile, "gone")).resolves.toBeNull();
  });

  it("saves the whole canvas under `canvas`", async () => {
    reply(200, { canvas: {} });
    const canvas = { positions: { a: { x: 24, y: 48 } }, areas: [{ id: "x", label: "Design", x: 0, y: 0, members: ["a"] }], texts: [], camera: { x: 1, y: 2, zoom: 0.5 } };
    await saveRoomCanvas(profile, "r1", canvas);
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ canvas });
  });

  it("fails loudly when the canvas is refused", async () => {
    reply(400, { error: "canvas is malformed" });
    await expect(saveRoomCanvas(profile, "r1", { positions: {}, areas: [], texts: [] })).rejects.toThrow("canvas is malformed");
  });

  it("counts the room's context items", async () => {
    reply(200, { dir: "/d", items: [{}, {}, {}], index: "" });
    await expect(fetchRoomContextCount(profile, "r1")).resolves.toBe(3);
  });

  it("sends a file as the raw body under its own name", async () => {
    reply(201, { item: {} });
    await addRoomContextFile(profile, "r1", new File(["hello"], "brief me.md"));
    expect(calls[0].url).toBe("http://10.0.0.5:8765/rooms/r1/context?name=brief%20me.md");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("stops and removes one agent by its path, and says how long the undo lasts", async () => {
    reply(200, { stopped: true });
    await stopRoomAgent(profile, "r1", "w1");
    expect(calls[0].url).toBe("http://10.0.0.5:8765/rooms/r1/agents/w1/stop");
    reply(200, { removed: ["w1", "w2"], undoMs: 8000 });
    await expect(removeRoomAgent(profile, "r1", "w1")).resolves.toEqual({ removed: ["w1", "w2"], undoMs: 8000 });
    expect(calls[1].url).toBe("http://10.0.0.5:8765/rooms/r1/agents/w1/remove");
  });
});

describe("parseRoomChannelMessage", () => {
  it("passes the four frames of the channel through and nothing else", () => {
    for (const type of ["room_snapshot", "room_agent_state", "room_agent_removed", "room_summary"]) {
      expect(parseRoomChannelMessage({ type })).toEqual({ type });
    }
    expect(parseRoomChannelMessage({ type: "pong" })).toBeNull();
    expect(parseRoomChannelMessage(42)).toBeNull();
    expect(parseRoomChannelMessage(null)).toBeNull();
  });
});
