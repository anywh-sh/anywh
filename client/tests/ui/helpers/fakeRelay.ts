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
  private readonly listeners: Record<string, Listener[]> = {
    open: [],
    close: [],
    message: [],
  };

  constructor(
    readonly url: string,
    private readonly onSend: (socket: FakeRelaySocket, data: string) => void,
    options: FakeRelayOptions = {},
  ) {
    queueMicrotask(() => {
      this.readyState = FakeRelaySocket.OPEN;
      this.dispatch("open", {});
      // Required before ChatPanel renders anything at all, including the
      // user's own bubble (useRelayClient.ts's `ready` gate) — without this
      // every test in this tier would hang on the first assertion after a
      // send.
      if (options.agentId)
        this.emitMessage({ type: "agent_state", agentId: options.agentId });
      if (options.catalogs)
        this.emitMessage({
          type: "model_catalogs_state",
          catalogs: options.catalogs,
        });
      if (options.agentId) {
        this.emitMessage({ type: "model_state", model: null });
        this.emitMessage({ type: "effort_state", effort: null });
      }
      this.emitMessage({ type: "caught_up" });
    });
  }

  addEventListener(type: string, handler: Listener): void {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener(type: string, handler: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter(
      (h) => h !== handler,
    );
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

/** One message the app sent, with the socket (hence the session) it went over. */
export interface SentMessage {
  url: string;
  message: Record<string, unknown>;
}

/** One entry of `GET /control/agents`, as the relay answers it. */
export interface FakeAgent {
  id: string;
  bin?: string;
  installed: boolean;
  version?: string | null;
  loggedIn?: boolean | null;
  loginCommand?: string | null;
  installUrl?: string | null;
}

/** The relay's control routes the onboarding talks to. Present = HTTP is
 * scripted (`/control/agents`, `/host-info`, `PATCH /control/profiles/:id`);
 * absent = every fetch rejects, as it always did. Mutable through
 * `FakeRelay.control`, so a test can install an agent between two checks. */
export interface FakeControl {
  /** What `GET /control/agents` lists, or "legacy" for a relay without the
   * route: its 426 carries no CORS header, so the app's fetch rejects and it
   * falls back to `/host-info`. */
  agents: FakeAgent[] | "legacy";
  /** The agents a legacy relay's `/host-info` reports. */
  hostInfoAgents?: string[];
  /** Status of `PATCH /control/profiles/:id`; 200 by default, 400 is what a
   * relay that predates the agent preference answers. */
  patchStatus?: number;
}

export interface FakeRelayOptions {
  control?: FakeControl;
  /** Sent right after `open`, with `agent_state` for `agentId` and the
   * connection-burst `model_state`/`effort_state` (both `null`): what a real
   * relay's burst carries and what the composer's pickers render from. */
  agentId?: string;
  catalogs?: Record<string, unknown>;
}

export interface FakeRelay {
  sockets: FakeRelaySocket[];
  /** Everything the app has sent, in order, whether or not the fake answers it. */
  sent: SentMessage[];
  /** Pushes a relay message to every open socket (only the mounted tab reacts). */
  emit: (message: unknown) => void;
  /** The scripted control routes (a copy of `options.control`), if any. */
  control: FakeControl | null;
  /** Every `PATCH /control/profiles/:id` the app made. */
  patches: { id: string; body: Record<string, unknown> }[];
  /** How many times `GET /control/agents` was asked. */
  agentChecks: () => number;
  /** Restores the real `WebSocket`/`fetch` globals — call in `afterEach`. */
  uninstall: () => void;
}

export function installFakeRelay(
  replyText = "fake relay reply",
  options: FakeRelayOptions = {},
): FakeRelay {
  const sockets: FakeRelaySocket[] = [];
  const sent: SentMessage[] = [];

  function onSend(socket: FakeRelaySocket, raw: string): void {
    const message = JSON.parse(raw) as { type?: string; text?: string };
    sent.push({ url: socket.url, message });
    if (message.type !== "user_message") return; // this tier only scripts the send flow so far
    queueMicrotask(() => {
      socket.emitMessage({
        type: "agent_event",
        event: { type: "text", text: replyText },
      });
      socket.emitMessage({
        type: "agent_event",
        event: { type: "turn_ended", stopped: false },
      });
    });
  }

  vi.stubGlobal(
    "WebSocket",
    class extends FakeRelaySocket {
      constructor(url: string) {
        super(url, onSend, options);
        sockets.push(this);
      }
    },
  );

  const control: FakeControl | null = options.control
    ? { ...options.control }
    : null;
  const patches: FakeRelay["patches"] = [];
  let agentChecks = 0;
  const reply = (status: number, body: unknown): Response =>
    ({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
    }) as Response;

  function handleControl(
    url: URL,
    init: { method?: string; body?: string } | undefined,
    scripted: FakeControl,
  ): Response | null {
    if (url.pathname === "/control/agents") {
      agentChecks++;
      // A legacy relay's answer never reaches here: its fetch rejects first
      // (see the stub below).
      if (scripted.agents === "legacy") return null;
      return reply(200, {
        agents: scripted.agents.map((a) => ({
          id: a.id,
          bin: a.bin ?? a.id,
          installed: a.installed,
          version: a.version ?? (a.installed ? "1.0.0" : null),
          loggedIn: a.loggedIn ?? (a.installed ? true : null),
          loginCommand: a.loginCommand ?? null,
          installUrl: a.installUrl ?? null,
        })),
      });
    }
    if (url.pathname === "/host-info") {
      const ids =
        scripted.agents === "legacy"
          ? (scripted.hostInfoAgents ?? [])
          : scripted.agents.filter((a) => a.installed).map((a) => a.id);
      return reply(200, {
        hostname: "fake",
        platform: "linux",
        editor: null,
        agents: ids.map((id) => ({ id, capabilities: {} })),
      });
    }
    const profileId = /^\/control\/profiles\/([^/]+)$/.exec(url.pathname)?.[1];
    if (profileId && init?.method === "PATCH") {
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      patches.push({ id: decodeURIComponent(profileId), body });
      const status = scripted.patchStatus ?? 200;
      if (status >= 400)
        return reply(status, { error: "label or colorIndex is required" });
      return reply(200, {
        id: decodeURIComponent(profileId),
        label: "Default",
        colorIndex: 0,
        createdAt: "",
        updatedAt: "",
        ...body,
      });
    }
    return null;
  }

  // Every mount-time relay fetch (GET /sessions, /control/profiles,
  // /control/themes) already tolerates rejection (see the .catch in each of
  // useSessionNames/useProfileSync/useThemes) — rejecting immediately keeps
  // this deterministic instead of letting happy-dom's fetch attempt a real,
  // slow/unpredictable connection to an address nothing is listening on.
  // The control routes of `options.control` are the exception: scripted.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: { method?: string; body?: string }) => {
      const url = new URL(String(input));
      // A relay without the route answers 426 with no CORS header, which
      // the webview (another origin) can't read: the fetch itself rejects.
      if (control?.agents === "legacy" && url.pathname === "/control/agents") {
        agentChecks++;
        return Promise.reject(new TypeError("Load failed"));
      }
      const scripted = control && handleControl(url, init, control);
      return scripted
        ? Promise.resolve(scripted)
        : Promise.reject(
            new Error("fakeRelay: HTTP not scripted in this test"),
          );
    }),
  );

  return {
    sockets,
    control,
    patches,
    agentChecks: () => agentChecks,
    emit: (message) => {
      for (const socket of sockets) socket.emitMessage(message);
    },
    sent,
    uninstall: () => vi.unstubAllGlobals(),
  };
}
