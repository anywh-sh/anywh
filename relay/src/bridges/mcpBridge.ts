import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

// Structured multiple-choice questions — the relay exposes this as
// a real MCP tool (`present_choice`) instead of relying on the model to
// follow a text convention, so the client gets a genuine `tool_use` to
// render a picker from, the same guarantee the native `AskUserQuestion` has
// in interactive mode (unavailable to us in headless — it never gets a real
// answer channel there).
//
// Input schema mirrors `AskUserQuestion`'s real one on purpose (captured
// from a live call) — the model already has training affinity
// with this exact shape, which came out more reliable in testing than a
// schema invented from scratch.
export interface ChoiceOption {
  label: string;
  description?: string;
  /** Stable identifier for an option the *relay* wrote, so the answer can be
   * matched without comparing the label a client rendered. Absent on every
   * option the model wrote (`present_choice`), where the label is the answer
   * — it's what gets fed back to the model. */
  id?: string;
}

export interface ChoiceQuestion {
  question: string;
  header?: string;
  options: ChoiceOption[];
  multiSelect?: boolean;
  /** Present only on a permission prompt, which the relay composes rather
   * than the model. Carries the parts instead of a finished sentence so the
   * client can write the question in the user's own language; `question` and
   * the option labels are still filled in, in English, for any client too old
   * to know about this field. */
  approval?: {
    /** The tool awaiting a verdict. `ExitPlanMode` reads differently from
     * the rest — it's a mode transition, not an action. */
    tool: string;
    /** What the call would do: the command for `Bash`, the path for an edit,
     * the raw input otherwise. Never translated — it's data. */
    detail: string;
  };
}

export interface ChoiceAnswer {
  question: string;
  selected: string[];
}

/** What a turn (`SharedSession.runTurn`) must provide to have its pending
 * `present_choice` calls actually go somewhere — kept minimal on purpose so
 * `SharedSession` doesn't need to know anything about MCP/JSON-RPC framing,
 * only "here's a question, publish it".
 *
 * Synchronous and fire-and-forget on purpose (this
 * used to be `Promise<ChoiceAnswer[]>`, held open by `handleRequest` until a
 * human answered): the CLI kills any MCP `tools/call` that takes longer than
 * ~6 minutes to resolve, no documented override actually prevents it, and a
 * human reading a prompt on their phone routinely takes longer than that.
 * `presentChoice` now just records the question and returns immediately —
 * `handleRequest` replies to the tool call right away (see
 * `CHOICE_DEFERRED_RESPONSE_TEXT` below), the turn ends normally, and the
 * eventual human answer arrives as a brand new turn instead of a resolved
 * promise (`SharedSession.answerChoice`). Returns `false` instead of `true`
 * if a previous prompt from this same host is still unanswered — only one
 * can be pending at a time, and silently overwriting it would either lose
 * the first question or leave two answers racing for the same UI slot. */
export interface ChoiceHost {
  presentChoice(questions: ChoiceQuestion[]): boolean;
}

export const CHOICE_MCP_SERVER_NAME = "anywh-choice";
const TOOL_NAME = "present_choice";
export const CHOICE_ALLOWED_TOOL = `mcp__${CHOICE_MCP_SERVER_NAME}__${TOOL_NAME}`;

// Real-session finding (2026-09-09): the CLI's MCP tool search feature can
// list `present_choice` by name only, with its schema deferred, even though
// `--allowedTools` already grants it — the model then has no `tool_use` it
// can actually fill in and, seeing nothing usable, never calls it at all
// (confirmed live: it fell back to describing the options in prose and
// asked the human to just answer in chat, defeating the whole point of this
// tool). Fixed via `alwaysLoad: true` on this server's `SharedSession.runTurn`
// entry: the CLI docs confirm that keeps a server's tools out of deferral
// entirely, regardless of `ENABLE_TOOL_SEARCH` — `present_choice` now always
// arrives with its full schema already loaded, same status as a built-in
// tool, no model decision to search required at all.
//
// That alone turned out not to be enough, also confirmed live against the
// real binary (2026-09-09): with the schema always loaded, `AskUserQuestion`
// disallowed, and nothing else competing, the model still answered a
// genuinely closed question in plain prose instead of calling
// `present_choice` — this was never a discoverability gap on its own, the
// model just has no trained reflex toward an MCP tool the way it does
// toward the *native* `AskUserQuestion` (which can't be used here at all —
// it never gets a real answer channel in headless).
// An explicit imperative line fixed it in that same test. `CHOICE_USAGE_HINT`
// below is that line, folded into `--append-system-prompt` only for turns
// where `present_choice` is registered (`SharedSession.runTurn`). It's a
// probabilistic nudge, not a guarantee — a long, saturated context can still
// bury it — but it's the closest thing available short of a real first-party
// tool with a working answer channel in headless mode.
export const CHOICE_USAGE_HINT =
  `Use the ${TOOL_NAME} tool (server ${CHOICE_MCP_SERVER_NAME}) to ask the human any genuinely ` +
  "closed multiple-choice question — never write the options out as plain text instead, even when " +
  `that feels like the natural way to ask. ${TOOL_NAME} is the only way the human's answer becomes ` +
  "a real UI selection instead of a message they have to type by hand.";

// The `tool_result` text for a
// successful `present_choice` call. Doesn't carry any answer (there isn't
// one yet): its whole job is to get the model to stop turning, imperatively,
// since the only way the human's eventual answer reaches the conversation is
// as the FIRST message of a brand new turn (`SharedSession.answerChoice`),
// not as this call's return value. A model that ignores this and keeps
// working anyway is an accepted, degraded outcome (see `SharedSession`'s
// `pendingChoice` doc comment) — the prompt is already on screen and the
// answer still lands correctly, it's just not guaranteed to be the very next
// thing the model does.
export const CHOICE_DEFERRED_RESPONSE_TEXT =
  "Question presented to the user. End your turn now without further tool calls; the user's answer " +
  "will arrive as their next message.";

// Returned instead of the text above when a previous `present_choice` call
// from the SAME turn is still unanswered (`ChoiceHost.presentChoice` ->
// `false`) — e.g. the model ignored `CHOICE_DEFERRED_RESPONSE_TEXT` above
// and called the tool a second time. `isError: true` (see `handleRequest`)
// so the model sees this as a rejected call, not a second real question.
export const CHOICE_ALREADY_PENDING_TEXT =
  "A previous present_choice question is still waiting on the user's answer. Do not call this tool " +
  "again until they respond — end your turn now without further tool calls.";

const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description:
    "Ask the human one or more closed multiple-choice questions and wait for their answer. Only for " +
    "genuinely closed decisions with a fixed set of options — for open-ended requests for more detail, " +
    "keep answering in prose instead.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            },
            multiSelect: { type: "boolean" },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

/** Guards against writing to a connection that's already gone. Mostly
 * theoretical for this bridge now that `presentChoice` is synchronous (the
 * response goes out in the same tick it's requested — there's no `await`
 * left in between for the connection to die during), kept because it's
 * cheap and still real for the sibling bridge this pattern was copied from
 * (`permissionBridge.ts`'s `checkPermission`, which still genuinely blocks:
 * the `claude` child that made a `tools/call` can get SIGINT'd mid-wait
 * there, tearing down the HTTP connection before `await
 * host.checkPermission(...)` settles). */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Minimal hand-rolled server for the MCP "Streamable HTTP" transport — not a
 * general client library, just enough of the handshake (`initialize` →
 * `notifications/initialized` → `tools/list` → `tools/call`) to serve the
 * one tool `present_choice` needs, validated by hand against the real
 * `claude` binary before writing this (confirmed `--mcp-config`
 * accepts a `"type": "http"` server, confirmed the exact request/response
 * shapes below).
 *
 * `tools/call` used to hold the HTTP response open until a human answered —
 * confirmed working (no token cost while waiting) but abandoned: the CLI
 * kills a `tools/call` that takes longer than ~6
 * minutes to resolve, with no working override, and a human on their phone
 * routinely takes longer than that. `ChoiceHost.presentChoice` is now
 * synchronous — this bridge replies immediately, telling the model to end
 * its turn, and the human's actual answer arrives as a new turn instead
 * (`SharedSession.answerChoice`). See `ChoiceHost`'s doc comment for the
 * full reasoning.
 *
 * Runs in-process on the relay's own `httpServer` (`server.ts`) — no
 * separate subprocess. That matters: a subprocess-based MCP server (the
 * conventional stdio transport) would be a child of `claude`, not of the
 * relay, with no direct access to `SharedSession`/the WebSocket clients it
 * needs to actually ask a human. Being just another route on the relay's
 * existing HTTP server means `ChoiceHost.presentChoice` can call straight
 * into `SharedSession` with no IPC of our own to invent.
 *
 * One bridge instance is shared by every session in the process (like
 * `SessionManager`) — `registerTurn` hands out a random per-turn token that
 * both routes the incoming HTTP call to the right `ChoiceHost` and doubles
 * as the endpoint's only auth: the URL embedding the token is only ever
 * known to the one local `claude` child process spawned with it (always on
 * localhost — the relay's child, never reached over Tailscale, see the
 * `sendTurn` callers). Registered per turn, not per session: a turn that
 * never finishes (relay restart, `stopTurn`) can't leave a token pointing
 * at a `ChoiceHost` that no longer expects calls, since `unregister` runs in
 * the same `finally` that ends the turn either way.
 */
export class McpChoiceBridge {
  private readonly pending = new Map<string, ChoiceHost>();

  registerTurn(host: ChoiceHost): { token: string; unregister: () => void } {
    const token = randomUUID();
    this.pending.set(token, host);
    return { token, unregister: () => this.pending.delete(token) };
  }

  /** Mounted at `/mcp/:token` in `server.ts`. */
  async handleRequest(token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = this.pending.get(token);
    if (!host) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let message: JsonRpcRequest;
    try {
      message = (await readJsonBody(req)) as JsonRpcRequest;
    } catch {
      res.writeHead(400).end();
      return;
    }

    const { id, method, params } = message;
    // A JSON-RPC notification (no `id`, e.g. `notifications/initialized`)
    // gets no response body — confirmed against the real binary that it
    // doesn't wait for one, `202` with an empty body is enough.
    const isNotification = id === undefined;

    if (method === "initialize") {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          // Echoes back whatever the client asked for — validated against
          // the real binary that it accepts this instead of us pinning a
          // fixed version and risking a mismatch as the CLI evolves.
          protocolVersion: (params?.protocolVersion as string | undefined) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: CHOICE_MCP_SERVER_NAME, version: "1.0.0" },
        },
      });
      return;
    }

    if (method === "tools/list") {
      sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools: [TOOL_SCHEMA] } });
      return;
    }

    if (method === "tools/call" && params?.name === TOOL_NAME) {
      const args = params.arguments as { questions?: ChoiceQuestion[] } | undefined;
      const questions = args?.questions ?? [];
      const accepted = host.presentChoice(questions);
      if (!accepted) {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: CHOICE_ALREADY_PENDING_TEXT }], isError: true },
        });
        return;
      }
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: CHOICE_DEFERRED_RESPONSE_TEXT }] },
      });
      return;
    }

    // Anything else (an unrecognized method, e.g. the `server/discover`
    // preflight some CLI versions send) — validated that answering an empty
    // `result` for a request, or nothing for a notification, doesn't break
    // the handshake; the CLI only actually depends on the four methods above.
    if (isNotification) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, { jsonrpc: "2.0", id, result: {} });
  }
}
