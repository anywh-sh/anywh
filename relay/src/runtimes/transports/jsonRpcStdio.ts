// A JSON-RPC 2.0 connection over a byte stream, decoupled from *how* that
// stream's bytes actually move — `receive`/`write` are the only points of
// contact with the outside world, and both are plain strings, not a
// `child_process` or a socket. That split is deliberate: `codexDaemon.ts`
// owns spawning `codex app-server` and wiring its stdin/stdout into this
// file; this file only knows "requests get an id and a matching response,
// notifications don't, and the other side can send either back". The same
// connection is meant to drive Codex today and ACP later — `framing` is the
// one axis those two actually differ on (see `JsonRpcDaemonPlan` in
// `../types.ts`), everything else here is shared.

export type Framing = "ndjson" | "lsp-headers";

export type JsonRpcId = string | number;

export interface JsonRpcErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** JSON-RPC error codes this file produces itself — not the far end's,
 * which can be anything and is passed through verbatim. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;

export class JsonRpcRemoteError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(shape: JsonRpcErrorShape) {
    super(shape.message);
    this.name = "JsonRpcRemoteError";
    this.code = shape.code;
    this.data = shape.data;
  }
}

// ---------------------------------------------------------------------------
// Framing — turning a byte stream into complete JSON-text frames (and back).
// Pure: no clock, no process, no socket. The two shapes on the wire today:
// ndjson (one JSON value per line, Codex) and lsp-headers
// (`Content-Length`-prefixed, like LSP — the shape ACP uses).

export function encodeFrame(framing: Framing, payload: string): string {
  if (framing === "ndjson") return `${payload}\n`;
  return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
}

export interface FrameDecoder {
  /** Feed a raw chunk as it arrives; returns zero or more complete JSON-text
   * frames extracted from the accumulated buffer. A frame split across two
   * chunks (a real possibility on any stream, not a corner case) is held
   * until the rest arrives — nothing is ever emitted early. */
  push(chunk: string): readonly string[];
}

function createNdjsonDecoder(): FrameDecoder {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const frames: string[] = [];
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt).replace(/\r$/, "");
        buffer = buffer.slice(newlineAt + 1);
        // A blank line between frames isn't part of the protocol on either
        // side seen so far, but tolerating it costs nothing and matches how
        // the ndjson line reader elsewhere in this codebase already skips
        // blank lines (runtimes/defs/claude/session.ts's readLines).
        if (line.trim().length > 0) frames.push(line);
        newlineAt = buffer.indexOf("\n");
      }
      return frames;
    },
  };
}

function createLspHeaderDecoder(): FrameDecoder {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const frames: string[] = [];
      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const header = buffer.slice(0, headerEnd);
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          // A header block without a Content-Length is malformed input, not
          // a partial frame — drop it instead of looping on it forever.
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const bodyStart = headerEnd + 4;
        const length = Number(match[1]);
        if (buffer.length < bodyStart + length) break; // body not fully arrived yet
        frames.push(buffer.slice(bodyStart, bodyStart + length));
        buffer = buffer.slice(bodyStart + length);
      }
      return frames;
    },
  };
}

export function createFrameDecoder(framing: Framing): FrameDecoder {
  return framing === "ndjson" ? createNdjsonDecoder() : createLspHeaderDecoder();
}

// ---------------------------------------------------------------------------
// The connection — id correlation plus requests flowing in either
// direction. `write` is injected rather than this file owning a stream, so
// a unit test can assert on exactly what would have gone out over the wire
// without spawning anything (`codexDaemon.ts` is what actually wires this
// to a child's stdin/stdout).

export interface JsonRpcConnectionOptions {
  readonly framing: Framing;
  readonly write: (chunk: string) => void;
  /** A notification from the other side (no `id`, no response expected). */
  readonly onNotification: (method: string, params: unknown) => void;
  /** A request from the other side (`id` present, a response is expected
   * back). Returning `undefined` means "not mine" — the connection replies
   * with a method-not-found error itself, so the sender never hangs waiting
   * on a request nobody answers. */
  readonly onRequest: (method: string, params: unknown) => Promise<unknown> | undefined;
}

export interface JsonRpcConnection {
  /** Feed raw bytes as they arrive from the wire (e.g. a child's stdout
   * `data` event, decoded to a string). */
  receive(chunk: string): void;
  /** Send a request and resolve with its result, or reject with a
   * `JsonRpcRemoteError` carrying the far end's `code`/`data`. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Send a one-way notification — no response is ever expected for it. */
  notify(method: string, params: unknown): void;
  /** Requests still awaiting a response — a daemon reaper checks this
   * before deciding a connection is idle enough to kill. */
  readonly pendingCount: number;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export function createJsonRpcConnection(options: JsonRpcConnectionOptions): JsonRpcConnection {
  const decoder = createFrameDecoder(options.framing);
  const pending = new Map<JsonRpcId, PendingRequest>();
  let nextId = 1;

  function send(message: Record<string, unknown>): void {
    options.write(encodeFrame(options.framing, JSON.stringify(message)));
  }

  function handleFrame(frame: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(frame) as Record<string, unknown>;
    } catch {
      // Same posture as runtimes/streams/claudeStreamJson.ts's mapper: a
      // frame that isn't valid JSON is dropped, not fatal to the
      // connection — one bad line from a daemon shouldn't take the whole
      // session down.
      return;
    }

    const id = message.id as JsonRpcId | undefined;
    const method = message.method as string | undefined;

    if (method !== undefined && id !== undefined) {
      handleIncomingRequest(id, method, message.params);
      return;
    }
    if (method !== undefined) {
      options.onNotification(method, message.params);
      return;
    }
    if (id !== undefined) {
      handleResponse(id, message);
    }
  }

  function handleIncomingRequest(id: JsonRpcId, method: string, params: unknown): void {
    const result = options.onRequest(method, params);
    if (result === undefined) {
      send({ jsonrpc: "2.0", id, error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
      return;
    }
    result.then(
      (value) => send({ jsonrpc: "2.0", id, result: value ?? null }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
      },
    );
  }

  function handleResponse(id: JsonRpcId, message: Record<string, unknown>): void {
    const entry = pending.get(id);
    if (!entry) return; // response to a request we didn't send (or already settled) — ignore
    pending.delete(id);
    if (message.error) {
      const errorShape = message.error as JsonRpcErrorShape;
      entry.reject(new JsonRpcRemoteError(errorShape));
    } else {
      entry.resolve(message.result);
    }
  }

  return {
    receive(chunk) {
      for (const frame of decoder.push(chunk)) handleFrame(frame);
    },
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, params });
    },
    get pendingCount() {
      return pending.size;
    },
  };
}
