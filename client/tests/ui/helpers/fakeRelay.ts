import { vi } from "vitest";
import type { RuntimePlanUsage } from "@/lib/planUsage/model";

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
    planUsage?: () => FakePlanUsage | undefined,
  ) {
    const parsed = new URL(url);
    if (parsed.pathname === "/plan-usage/watch" && planUsage) {
      queueMicrotask(() => this.openPlanUsage(planUsage()));
      return;
    }
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

  /** `/plan-usage/watch`, answered the way each kind of relay does. */
  private openPlanUsage(script: FakePlanUsage | undefined): void {
    if (this.readyState === FakeRelaySocket.CLOSED) return;
    if (script === undefined || script === "unreachable") {
      // A socket that never opens: the browser fires `close` alone (after an
      // `error` nobody here listens to).
      this.readyState = FakeRelaySocket.CLOSED;
      this.dispatch("close", {});
      return;
    }
    this.readyState = FakeRelaySocket.OPEN;
    this.dispatch("open", {});
    if (script === "legacy") {
      // A relay without the route treats the path as a chat socket.
      this.emitMessage({ type: "protocol_version", version: 1 });
      this.emitMessage({ type: "caught_up" });
      return;
    }
    this.emitMessage({ type: "plan_usage_state", runtimes: script.runtimes, observedAt: script.observedAt ?? Date.now() });
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

/** How a relay answers `/plan-usage/watch`: its state (sent on connect, and
 * again in answer to every `plan_usage_refresh`), `"legacy"` for a relay
 * that predates the route, `"unreachable"` for a machine that can't be
 * reached. */
export type FakePlanUsage =
  | {
      runtimes: RuntimePlanUsage[];
      observedAt?: number;
      /** Answer a refresh like a real read: a state with every runtime
       * `reading` at once, then the plain state this many ms later. Absent =
       * the plain state right away. */
      readMs?: number;
    }
  | "legacy"
  | "unreachable";

export interface FakeRelayOptions {
  /** `/plan-usage/watch` per relay, keyed `host:port`. Absent = the route is
   * not scripted and the socket behaves like any other. Mutable through
   * `FakeRelay.planUsage`, read on every connection. */
  planUsage?: Record<string, FakePlanUsage>;
  control?: FakeControl;
  /** Sent right after `open`, with `agent_state` for `agentId` and the
   * connection-burst `model_state`/`effort_state` (both `null`): what a real
   * relay's burst carries and what the composer's pickers render from. */
  agentId?: string;
  catalogs?: Record<string, unknown>;
}

export interface FakeRelay {
  sockets: FakeRelaySocket[];
  /** The scripted `/plan-usage/watch` answers (a copy of `options.planUsage`). */
  planUsage: Record<string, FakePlanUsage> | null;
  /** Makes one relay's open plan usage sockets go silent without closing —
   * a connection that died with no close frame. New sockets answer again. */
  silentPlanUsage: (hostPort: string) => void;
  /** Pushes a `plan_usage_state` to the open plan usage sockets of one relay. */
  emitPlanUsage: (hostPort: string, runtimes: RuntimePlanUsage[], observedAt?: number) => void;
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

  const planUsage: Record<string, FakePlanUsage> | null = options.planUsage ? { ...options.planUsage } : null;
  const deadSockets = new Set<FakeRelaySocket>();
  const hostPort = (url: string): string => new URL(url).host;
  const isPlanUsageSocket = (socket: FakeRelaySocket): boolean => new URL(socket.url).pathname === "/plan-usage/watch";

  function onSend(socket: FakeRelaySocket, raw: string): void {
    const message = JSON.parse(raw) as { type?: string; text?: string };
    sent.push({ url: socket.url, message });
    if (message.type === "ping" && planUsage && isPlanUsageSocket(socket)) {
      // The relay's liveness answer — unless the test made this relay go
      // silent (`silentPlanUsage`), the way a dead connection looks.
      if (!deadSockets.has(socket)) queueMicrotask(() => socket.emitMessage({ type: "pong" }));
      return;
    }
    if (message.type === "plan_usage_refresh" && planUsage) {
      if (deadSockets.has(socket)) return;
      const script = planUsage[hostPort(socket.url)];
      if (typeof script !== "object") return;
      const answer = () => socket.emitMessage({ type: "plan_usage_state", runtimes: script.runtimes, observedAt: Date.now() });
      if (script.readMs === undefined) {
        queueMicrotask(answer);
        return;
      }
      const startedAt = Date.now();
      queueMicrotask(() =>
        socket.emitMessage({
          type: "plan_usage_state",
          runtimes: script.runtimes.map((usage) => ({ ...usage, reading: true, readingSince: startedAt })),
          observedAt: startedAt,
        }),
      );
      setTimeout(answer, script.readMs);
      return;
    }
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
        super(url, onSend, options, planUsage ? () => planUsage[hostPort(url)] : undefined);
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
    planUsage,
    silentPlanUsage: (target) => {
      // Only the sockets open now: the next connection is a new one.
      const dead = sockets.filter((socket) => isPlanUsageSocket(socket) && hostPort(socket.url) === target && socket.readyState === FakeRelaySocket.OPEN);
      for (const socket of dead) deadSockets.add(socket);
    },
    emitPlanUsage: (target, runtimes, observedAt) => {
      for (const socket of sockets) {
        if (socket.readyState !== FakeRelaySocket.OPEN || !isPlanUsageSocket(socket) || hostPort(socket.url) !== target || deadSockets.has(socket)) continue;
        socket.emitMessage({ type: "plan_usage_state", runtimes, observedAt: observedAt ?? Date.now() });
      }
    },
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
