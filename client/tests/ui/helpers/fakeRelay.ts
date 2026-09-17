import { vi } from "vitest";

/**
 * Stands in for the relay over the network edge — the client-side
 * equivalent of the relay's fake `claude` executable (see
 * .anywh/skills/tests/SKILL.md). `RelayClient` (client/src/lib/relay/relayClient.ts)
 * is never touched directly here; everything is driven through the real
 * `WebSocket`/`fetch` calls it makes, same as it would against a real relay.
 *
 * Behavior on the one flow this tier currently exercises (sending a message):
 * every socket auto-opens, then auto-sends `caught_up` (required before
 * ChatPanel renders anything at all, including the user's own bubble — see
 * useRelayClient.ts), then answers a `user_message` with one `text`
 * agent_event carrying `replyText` followed by a `turn_ended` agent_event.
 */
type Listener = (event: { data?: string }) => void;

class FakeRelaySocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeRelaySocket.CONNECTING;
  private readonly listeners: Record<string, Listener[]> = { open: [], close: [], message: [] };

  constructor(
    readonly url: string,
    private readonly onSend: (socket: FakeRelaySocket, data: string) => void,
  ) {
    queueMicrotask(() => {
      this.readyState = FakeRelaySocket.OPEN;
      this.dispatch("open", {});
      // Required before ChatPanel renders anything at all, including the
      // user's own bubble (useRelayClient.ts's `ready` gate) — without this
      // every test in this tier would hang on the first assertion after a
      // send.
      this.emitMessage({ type: "caught_up" });
    });
  }

  addEventListener(type: string, handler: Listener): void {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener(type: string, handler: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler);
  }

  send(data: string): void {
    this.onSend(this, data);
  }

  close(): void {
    this.readyState = FakeRelaySocket.CLOSED;
    this.dispatch("close", {});
  }

  emitMessage(payload: unknown): void {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }

  private dispatch(type: string, event: { data?: string }): void {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
}

export interface FakeRelay {
  sockets: FakeRelaySocket[];
  /** Restores the real `WebSocket`/`fetch` globals — call in `afterEach`. */
  uninstall: () => void;
}

export function installFakeRelay(replyText = "fake relay reply"): FakeRelay {
  const sockets: FakeRelaySocket[] = [];

  function onSend(socket: FakeRelaySocket, raw: string): void {
    const message = JSON.parse(raw) as { type?: string; text?: string };
    if (message.type !== "user_message") return; // this tier only scripts the send flow so far
    queueMicrotask(() => {
      socket.emitMessage({ type: "agent_event", event: { type: "text", text: replyText } });
      socket.emitMessage({ type: "agent_event", event: { type: "turn_ended", stopped: false } });
    });
  }

  vi.stubGlobal(
    "WebSocket",
    class extends FakeRelaySocket {
      constructor(url: string) {
        super(url, onSend);
        sockets.push(this);
      }
    },
  );

  // Every mount-time relay fetch (GET /sessions, /control/profiles,
  // /control/themes) already tolerates rejection (see the .catch in each of
  // useSessionNames/useProfileSync/useThemes) — rejecting immediately keeps
  // this deterministic instead of letting happy-dom's fetch attempt a real,
  // slow/unpredictable connection to an address nothing is listening on.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("fakeRelay: HTTP not scripted in this test"))),
  );

  return {
    sockets,
    uninstall: () => vi.unstubAllGlobals(),
  };
}
