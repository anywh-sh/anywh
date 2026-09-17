import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayClient, type RelayClientCallbacks } from "@/lib/relay/relayClient";
import { WS_PROTOCOL_VERSION } from "@/lib/relay/protocolVersion";
import { BrokerAsleepError, BrokerRevokedError, BrokerThrottledError } from "@/lib/profiles/tailnetBroker";

/** Minimal stand-in for the browser `WebSocket` — records the URL it was
 * opened with and lets a test drive `open`/`close` by hand. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readyState = 0;
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  send(): void {}

  close(): void {
    this.emit("close");
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The callbacks are beside the point here — none of these tests get far
 * enough for the relay to send anything. */
const noopCallbacks: RelayClientCallbacks = {
  onEvent: () => {},
  onTurnComplete: () => {},
  onTurnError: () => {},
  onCaughtUp: () => {},
  onCwdState: () => {},
  onAgentState: () => {},
  onPermissionModeState: () => {},
  onModelState: () => {},
  onDraftState: () => {},
};

function tokenOf(socket: FakeWebSocket): string | null {
  return new URL(socket.url.replace("ws://", "http://")).searchParams.get("token");
}

describe("RelayClient connect token", () => {
  it("asks for a fresh token on every reconnection when given a resolver", async () => {
    // A brokered profile's connection token authorizes
    // exactly one handshake — the proxy spends its `jti` (an anti-replay
    // check on the control plane's side) and refuses it forever after. Reusing the token
    // the first connection was opened with turns any dropped socket into a
    // permanent "reconnecting" loop.
    const tokens = ["grant-1", "grant-2", "grant-3"];
    const resolve = vi.fn(() => Promise.resolve(tokens.shift() ?? "exhausted"));
    const client = new RelayClient("127.0.0.1", 12345, "session-1", noopCallbacks, resolve);

    client.connect();
    await vi.runAllTimersAsync();
    expect(tokenOf(FakeWebSocket.instances[0])).toBe("grant-1");

    FakeWebSocket.instances[0].close();
    await vi.runAllTimersAsync();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(tokenOf(FakeWebSocket.instances[1])).toBe("grant-2");
  });

  it("keeps sending the same static token, for a profile whose token is a fixed credential", () => {
    // `Profile.connectToken` (a reverse proxy's static credential) is the
    // opposite case — nothing to refresh, and no async hop before dialing.
    const client = new RelayClient("127.0.0.1", 8765, "session-1", noopCallbacks, "static-secret");

    client.connect();

    expect(tokenOf(FakeWebSocket.instances[0])).toBe("static-secret");
  });

  it("stops retrying and fires onRevoked when the broker permanently revoked this device (410)", async () => {
    const resolve = vi.fn(() => Promise.reject(new BrokerRevokedError()));
    const onRevoked = vi.fn();
    const client = new RelayClient("127.0.0.1", 12345, "session-1", { ...noopCallbacks, onRevoked }, resolve);

    client.connect();
    await vi.runAllTimersAsync();

    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(0);

    // A generous window well past any exponential backoff (capped at 30s) —
    // if a reconnect were still scheduled, this would fire it.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("backs off for a minute when the broker says it is throttling this account (429)", async () => {
    const resolve = vi.fn(() => Promise.reject(new BrokerThrottledError()));
    const client = new RelayClient("127.0.0.1", 12345, "session-1", noopCallbacks, resolve);

    client.connect();
    // Just enough to settle the rejected promise, never enough to fire a
    // timer — runAllTimersAsync would fire the very backoff under test.
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenCalledTimes(1);

    // Well past the normal backoff's first steps, which would have retried
    // several times by now against an endpoint already saying "stop".
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolve).toHaveBeenCalledTimes(1);

    // Still transient, unlike a 410: it does come back, just far later.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("honors a longer retry hint from the broker over its own floor", async () => {
    const resolve = vi.fn(() => Promise.reject(new BrokerThrottledError(180_000)));
    const client = new RelayClient("127.0.0.1", 12345, "session-1", noopCallbacks, resolve);

    client.connect();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resolve).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(61_000);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("only asks to wake the machine for connections a person caused", async () => {
    // The first connection is the user opening the tab; every reconnect this
    // client schedules on its own is not, and the likeliest reason it's
    // reconnecting is the machine having gone to sleep because nobody was
    // using it. Waking it there is a loop with nobody in it.
    const resolve = vi.fn(() => Promise.reject(new Error("network unreachable")));
    const client = new RelayClient("127.0.0.1", 12345, "session-1", noopCallbacks, resolve);

    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenLastCalledWith({ wake: true });

    await vi.advanceTimersByTimeAsync(2000);
    expect(resolve).toHaveBeenLastCalledWith({ wake: false });

    // Coming back to the app is a person's doing again — and it's what makes
    // the background silence above safe.
    client.forceReconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenLastCalledWith({ wake: true });
  });

  it("backs off instead of spinning when the broker says the machine is asleep", async () => {
    const resolve = vi.fn(() => Promise.reject(new BrokerAsleepError()));
    const client = new RelayClient("127.0.0.1", 12345, "session-1", noopCallbacks, resolve);

    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolve).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying for any other token-resolution failure (transient, not revoked)", async () => {
    const resolve = vi.fn(() => Promise.reject(new Error("network unreachable")));
    const client = new RelayClient("127.0.0.1", 12345, "session-1", noopCallbacks, resolve);

    client.connect();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(resolve.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("RelayClient protocol version", () => {
  function receive(socket: FakeWebSocket, message: unknown): void {
    socket.emit("message", { data: JSON.stringify(message) });
  }

  it("stops retrying and fires onProtocolMismatch when the relay announces a different version", async () => {
    const onProtocolMismatch = vi.fn();
    const client = new RelayClient("127.0.0.1", 12345, "session-1", { ...noopCallbacks, onProtocolMismatch });

    client.connect();
    const socket = FakeWebSocket.instances[0];
    receive(socket, { type: "protocol_version", version: WS_PROTOCOL_VERSION + 1 });

    expect(onProtocolMismatch).toHaveBeenCalledTimes(1);
    expect(onProtocolMismatch).toHaveBeenCalledWith(WS_PROTOCOL_VERSION + 1);

    // The mismatch also closes the socket, and closing normally schedules a
    // reconnect — a generous window well past any exponential backoff (same
    // margin as the onRevoked test above) confirms `shouldReconnect` was
    // flipped off first, so this doesn't just loop back into the same
    // mismatch.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does nothing when the relay announces the version this build already expects", () => {
    const onProtocolMismatch = vi.fn();
    const client = new RelayClient("127.0.0.1", 12345, "session-1", { ...noopCallbacks, onProtocolMismatch });

    client.connect();
    const socket = FakeWebSocket.instances[0];
    receive(socket, { type: "protocol_version", version: WS_PROTOCOL_VERSION });

    expect(onProtocolMismatch).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
