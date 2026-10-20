import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverFirstRoomMessage } from "@/lib/sala/firstMessage";
import type { Profile } from "@/lib/profiles/profiles";

const profile: Profile = { id: "p", label: "P", host: "127.0.0.1", relayPort: 8765 };

type Listener = (event: { data?: string }) => void;

/** The session socket of a room's principal, as far as the first message
 * needs it: it either fails to connect, or replays history and says it has
 * caught up. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static plan: ("fail" | "ok")[] = [];
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Listener[]> = {};
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    const behaviour = FakeSocket.plan.shift() ?? "ok";
    queueMicrotask(() => {
      if (behaviour === "fail") this.emit("error", {});
      else this.emit("message", { data: JSON.stringify({ type: "caught_up" }) });
    });
  }

  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  FakeSocket.plan = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("deliverFirstRoomMessage", () => {
  it("sends the text to the room's own session once it has caught up, exactly once", async () => {
    const failed = vi.fn();
    const done = deliverFirstRoomMessage(profile, "room-1", "Redo the profile page", failed);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).toContain("session=room-1");
    expect(FakeSocket.instances[0].sent.map((m) => JSON.parse(m) as unknown)).toEqual([{ type: "user_message", text: "Redo the profile page" }]);
    expect(failed).not.toHaveBeenCalled();
  });

  it("tries again after a connection that failed, and does not send twice once one went through", async () => {
    FakeSocket.plan = ["fail", "ok"];
    const failed = vi.fn();
    const done = deliverFirstRoomMessage(profile, "room-1", "hi", failed);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0].sent).toEqual([]);
    expect(FakeSocket.instances[1].sent).toHaveLength(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it("gives up after three failed attempts and says so", async () => {
    FakeSocket.plan = ["fail", "fail", "fail", "ok"];
    const failed = vi.fn();
    const done = deliverFirstRoomMessage(profile, "room-1", "hi", failed);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(FakeSocket.instances).toHaveLength(3);
    expect(FakeSocket.instances.every((s) => s.sent.length === 0)).toBe(true);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
