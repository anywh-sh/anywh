import WebSocket from "ws";

/** Connects to the relay's chat WebSocket for one session and collects every
 * message the relay sends until `until` returns true (inclusive). Talks the
 * real wire protocol (`{"type":"user_message","text":...}` in,
 * `{"type":"agent_event",...}` out — server.ts/sharedSession.ts) — no
 * protocol mocking, only the `claude` process underneath is faked (see
 * testServer.ts). */
export function connectSession(port: number, sessionId: string): Promise<WebSocket> {
  return new Promise((resolveConn, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?session=${encodeURIComponent(sessionId)}`);
    socket.once("open", () => resolveConn(socket));
    socket.once("error", reject);
  });
}

/**
 * Connects like `connectSession`, but for tests that need to observe the
 * connection-time state burst `SharedSession.addClient` sends (cwd_state,
 * permission_mode_state, draft_state, history_page, caught_up, ...) — those
 * frames are written synchronously inside the server's `connection` handler,
 * often arriving in the same TCP read as the WS handshake response itself.
 * Real finding building the draft-persistence test: `connectSession`
 * resolving on `open` and THEN calling `collectUntil` separately has a real
 * gap — `ws`'s client parser can emit several `message` events synchronously
 * (within the same call stack that fires `open`) before the `await` on
 * `connectSession` even returns control to the caller, silently dropping
 * every message emitted in that window since nothing was listening yet. This
 * attaches the collector in the SAME synchronous tick the socket is
 * constructed, before `open` can possibly fire, so nothing is missed.
 */
export function connectSessionAndCollectUntil(
  port: number,
  sessionId: string,
  until: (message: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<{ socket: WebSocket; messages: Record<string, unknown>[] }> {
  return new Promise((resolveConn, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?session=${encodeURIComponent(sessionId)}`);
    const collected: Record<string, unknown>[] = [];
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`connectSessionAndCollectUntil timed out after ${timeoutMs}ms, collected so far: ${JSON.stringify(collected)}`));
    }, timeoutMs);

    function onMessage(raw: Buffer): void {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      collected.push(message);
      if (until(message)) {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolveConn({ socket, messages: collected });
      }
    }

    socket.on("message", onMessage);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/** Connects to `/sessions/watch` — the sidebar's list-wide broadcast channel
 * (`session_list_upsert`/`session_list_removed`), unscoped to any one
 * session id. Reuses `collectUntil` below to read its frames. */
export function connectSessionListWatch(port: number): Promise<WebSocket> {
  return new Promise((resolveConn, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sessions/watch`);
    socket.once("open", () => resolveConn(socket));
    socket.once("error", reject);
  });
}

export function sendUserMessage(socket: WebSocket, text: string): void {
  socket.send(JSON.stringify({ type: "user_message", text }));
}

/** Collects parsed messages until `until(message)` returns true, or rejects
 * after `timeoutMs` — explicit synchronization on the actual event stream,
 * not an arbitrary sleep (see the skill's "Determinism" section). */
export function collectUntil(
  socket: WebSocket,
  until: (message: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolveCollect, reject) => {
    const collected: Record<string, unknown>[] = [];
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`collectUntil timed out after ${timeoutMs}ms, collected so far: ${JSON.stringify(collected)}`));
    }, timeoutMs);

    function onMessage(raw: Buffer): void {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      collected.push(message);
      if (until(message)) {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolveCollect(collected);
      }
    }

    socket.on("message", onMessage);
  });
}

/** `collectUntil`/`connectSessionAndCollectUntil` predicate for "the turn is
 * over" — every integration test that waits for a turn to finish (success,
 * error, or `stop_turn`) ends up needing exactly this, since `turn_ended`
 * replaced the old top-level `turn_complete`/`turn_error` messages. */
export function isTurnEnded(message: Record<string, unknown>): boolean {
  return message.type === "agent_event" && (message.event as { type?: string } | undefined)?.type === "turn_ended";
}

/** Finds a specific `agent_event` variant among collected messages — the
 * other half of most `isTurnEnded` uses, once the turn's messages are in
 * hand and the test wants to inspect one of them (e.g. `session_id`). */
export function findAgentEvent<T extends string>(
  messages: Record<string, unknown>[],
  type: T,
): Record<string, unknown> | undefined {
  return messages.find(
    (message) => message.type === "agent_event" && (message.event as { type?: string } | undefined)?.type === type,
  );
}
