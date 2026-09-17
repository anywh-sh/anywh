import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { McpChoiceBridge } from "./bridges/mcpBridge.js";
import { McpPermissionBridge } from "./bridges/permissionBridge.js";
import { defaultCwd } from "./host/paths.js";
import { ensureSelfRegistered } from "./host/profileRegistry.js";
import { claudeRuntimeDef } from "./runtimes/defs/claude/index.js";
import { codexRuntimeDef } from "./runtimes/defs/codex.js";
import { detectRuntimes } from "./runtimes/detection.js";
import { buildRegistry } from "./runtimes/registry.js";
import { detectDefaultModel, type DefaultModelInfo } from "./runtimes/probes/defaultModel.js";
import { gracefulShutdown } from "./lifecycle.js";
import { handleFilesRoutes } from "./routes/files.js";
import { handleHostRoutes, setSelectableAgents } from "./routes/host.js";
import { handleProfileRoutes } from "./routes/profiles.js";
import { handleSessionRoutes } from "./routes/sessions.js";
import { handleThemeRoutes } from "./routes/themes.js";
import type { RouteContext, RouteHandler } from "./routes/context.js";
import { WS_PROTOCOL_VERSION } from "./protocol/version.js";
import { SessionManager } from "./session/sessionManager.js";
import { SessionStore } from "./session/sessionStore.js";
import { dispatchChatMessage } from "./ws/chat.js";
import { handleFilesConnection } from "./ws/files.js";
import { handleTerminalConnection } from "./ws/terminal.js";

// Config via env — allows running one instance per profile (systemd,
// infra/systemd/) without changing code, same as ttyd used to do.
const PORT = Number(process.env.RELAY_PORT ?? 8765);
const HOST = process.env.RELAY_HOST ?? "127.0.0.1";
const HOME_OVERRIDE = process.env.RELAY_HOME_OVERRIDE;
ensureSelfRegistered({ port: PORT, host: HOST, homeOverride: HOME_OVERRIDE });
const DEFAULT_SESSION = "default";

// Same pattern as RELAY_UPLOAD_DIR: the two systemd services (personal/
// work) share WorkingDirectory, so a fixed relative path would collide
// between profiles — needs a dedicated env var in production. The
// "./sessions.local.json" fallback is only for local `npm run dev`.
const SESSIONS_FILE = process.env.RELAY_SESSIONS_FILE ?? "./sessions.local.json";

// Same reasoning as SESSIONS_FILE — persistence of the
// watched `anywh-bg` jobs (survives a relay restart).
const BACKGROUND_JOBS_FILE = process.env.RELAY_BACKGROUND_JOBS_FILE ?? "./background-jobs.local.json";

// Same reasoning as BACKGROUND_JOBS_FILE — persistence of an armed
// `ScheduleWakeup` timer (survives a relay restart).
const WAKEUPS_FILE = process.env.RELAY_WAKEUPS_FILE ?? "./wakeups.local.json";

const sessionStore = new SessionStore(SESSIONS_FILE, defaultCwd(HOME_OVERRIDE));
// Always `127.0.0.1`, never `HOST`: this is the address the
// relay's OWN `claude` child processes reach it at, always local to this
// machine (see the comment on `SharedSessionOptions.mcpBridgeBaseUrl`), not
// the address remote clients (possibly over Tailscale) use.
const mcpChoiceBridge = new McpChoiceBridge();
// Separate bridge/path from `mcpChoiceBridge` (own token
// namespace, own route below) even though both are the same "local-only MCP
// server the relay's own `claude` children call into" idea.
const mcpPermissionBridge = new McpPermissionBridge();
// Sockets connected to `/sessions/watch` (client/src/hooks/relay/useSessionNames.ts)
// — one per device showing the sidebar, independent of which session tabs
// (if any) it has open. `SessionManager` doesn't know about WebSocket at
// all; it just reports list changes through `onListChanged` below, and this
// is where they get fanned out.
const sessionListWatchers = new Set<WebSocket>();
// Every def this relay can actually drive a turn with, coherence-checked
// once at boot (an incoherent def is excluded and logged, never crashes the
// relay — see assertCoherent's own doc comment) — `SessionManager.createSession`
// resolves a session's persisted agentId against this instead of a
// hardcoded literal.
const registry = buildRegistry([claudeRuntimeDef, codexRuntimeDef]);
const sessionManager = new SessionManager(
  HOME_OVERRIDE,
  sessionStore,
  registry,
  BACKGROUND_JOBS_FILE,
  WAKEUPS_FILE,
  mcpChoiceBridge,
  `http://127.0.0.1:${PORT}/mcp`,
  mcpPermissionBridge,
  `http://127.0.0.1:${PORT}/permission`,
  (event) => {
    const payload = JSON.stringify(
      event.type === "upsert"
        ? { type: "session_list_upsert", id: event.id, title: event.title, lastActiveAt: event.lastActiveAt }
        : { type: "session_list_removed", id: event.id },
    );
    for (const watcher of sessionListWatchers) {
      if (watcher.readyState === watcher.OPEN) watcher.send(payload);
    }
  },
);

const routeContext: RouteContext = {
  sessionStore,
  sessionManager,
  homeOverride: HOME_OVERRIDE,
  port: PORT,
  defaultSession: DEFAULT_SESSION,
};

// Tried in this order, but order only matters within a group — no two
// groups match overlapping URL prefixes (see docs/architecture.md).
const routeHandlers: readonly RouteHandler[] = [
  handleSessionRoutes,
  handleProfileRoutes,
  handleThemeRoutes,
  handleFilesRoutes,
  handleHostRoutes,
];

/**
 * `/mcp/:token` and `/permission/:token` — the relay's own `claude` children
 * call these to resolve `present_choice`/`ExitPlanMode`. `token`
 * is generated fresh per turn (SharedSession) and is each route's only
 * auth — no session/profile check needed beyond it, since only a
 * `--mcp-config`/`--permission-prompt-tool` we ourselves handed to a local
 * child process ever knows it. Shared between `httpServer` (bound to
 * `HOST`, whatever the operator configured for remote/Tailscale access) and
 * `loopbackServer` below (always `127.0.0.1`, so these two routes stay
 * reachable from local children even when `HOST` is a Tailscale-only
 * address the loopback interface can't reach — see that server's comment).
 */
function handleBridgeRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const mcpMatch = req.url?.match(/^\/mcp\/([^/]+)$/);
  if (mcpMatch) {
    void mcpChoiceBridge.handleRequest(mcpMatch[1], req, res);
    return true;
  }
  const permissionMatch = req.url?.match(/^\/permission\/([^/]+)$/);
  if (permissionMatch) {
    void mcpPermissionBridge.handleRequest(permissionMatch[1], req, res);
    return true;
  }
  return false;
}

// Probing this profile's account default model — runs once at
// boot, in parallel with everything else (doesn't block `httpServer.listen`
// below). `defaultModelClients` covers the obvious race: the first client's
// WS connection almost always arrives before the probe resolves. Also
// carries the full model catalog (`available`) straight from the CLI's own
// usage text, replacing what used to be a hardcoded list.
let defaultModelInfo: DefaultModelInfo | undefined;
const defaultModelClients = new Set<WebSocket>();
detectDefaultModel(HOME_OVERRIDE, defaultCwd(HOME_OVERRIDE))
  .then((info) => {
    defaultModelInfo = info;
    if (!info) return;
    for (const client of defaultModelClients) {
      client.send(JSON.stringify({ type: "default_model_state", label: info.label, available: info.available }));
    }
  })
  .catch((error: unknown) => {
    console.error("[relay] failed to detect default model:", error);
  });

// Every agent id a client may pick for a session. `detectRuntimes` below
// filters further on `installed`, so a relay without the `codex` binary
// still only ever offers Claude. Extending this list is how the relay
// learns a new agent — same shape as `BILLED_CREDENTIAL_VARS` in
// `runtimes/executables.ts`, which also grows per agent.
const SELECTABLE_AGENT_IDS = ["claude", "codex"];

detectRuntimes([claudeRuntimeDef, codexRuntimeDef], HOME_OVERRIDE)
  .then((detections) => {
    setSelectableAgents(
      detections.filter((detection) => detection.installed && SELECTABLE_AGENT_IDS.includes(detection.id)).map((detection) => ({ id: detection.id, capabilities: detection.capabilities })),
    );
  })
  .catch((error: unknown) => {
    // detectRuntimes itself never rejects (detection.ts's own contract) —
    // this only exists so a mistake in that contract fails loudly instead
    // of leaving /host-info's `agents` silently empty forever.
    console.error("[relay] failed to detect agent runtimes:", error);
  });

// Exported so integration tests (relay/tests/) can close both servers in
// teardown — this module runs its listen/connection wiring as a side effect
// of being imported, so a test that imports it needs a handle to shut it
// down again without killing the whole process.
async function dispatchRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  for (const handler of routeHandlers) {
    if (await handler(req, res, routeContext)) return;
  }
  res.writeHead(426);
  res.end();
}

export const httpServer = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.writeHead(204);
    res.end();
    return;
  }

  if (handleBridgeRequest(req, res)) return;

  void dispatchRoute(req, res);
});

// Real-session finding (2026-09-09): the permission-approval MCP bridge
// (permissionBridge.ts) holds a `tools/call` POST open for as long as a
// human takes to answer — genuinely minutes, not milliseconds (the
// present_choice bridge, mcpBridge.ts, USED to as well, but its deferred
// lifecycle rework replies immediately now, see the comment on
// `SharedSession.presentChoice` — kept the request timeout disabled below
// regardless, since it's still real for the permission bridge and costs
// nothing for every other route on this server, which all respond in
// milliseconds). Node's `http.Server` has defaulted `requestTimeout` to
// 300000ms (5 minutes) since Node 18: past that, Node itself would abort
// the request on its own, regardless of anything passed to the `claude`
// child's own `--mcp-config`. Live testing showed
// this was NOT the actual cause of the real "The operation timed out"
// failure a session hit at ~5m53s: an isolated reproduction with this exact
// override applied still failed at ~6 minutes. The real culprit is still
// unidentified, tracked as an open upstream CLI limitation — see
// `sharedSession.ts`'s `mcpServers` comment for the full investigation.
httpServer.requestTimeout = 0;

export const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, HOST, () => {
  console.log(`[relay] listening on ws://${HOST}:${PORT}`, HOME_OVERRIDE ? `(HOME=${HOME_OVERRIDE})` : "");
});

// Real-world bug: `httpServer` above binds ONLY to `HOST`, which
// for every profile except the self-registered "default" one is a Tailscale
// IP, not `127.0.0.1` (`RELAY_HOST` in each profile's `.env` — an operator
// choice, same trust boundary as the rest of the relay's auth-less HTTP/WS
// surface, not something this file should second-guess). A socket bound to
// a specific non-loopback address does NOT also answer on `127.0.0.1` — so
// `--mcp-config`/`--permission-prompt-tool` (both hardcoded to
// `http://127.0.0.1:${PORT}/...`, since the child is always local to this
// machine regardless of what remote address the relay itself listens on)
// got connection-refused, and the CLI silently dropped the tool. Confirmed
// with `ss -tlnp` + `curl` against a live profile: `present_choice` most
// likely never actually worked end-to-end in production despite shipping
// early on, only in isolated tests against a bare `127.0.0.1`-bound
// server — this is the fix.
//
// This second listener changes NONE of the operator-facing network surface
// (`httpServer`/`HOST` above is untouched) — `127.0.0.1` is unreachable
// from any other host by definition, so it adds no exposure, it just makes
// the "always local" promise already made in the URLs above actually true.
// Skipped when `HOST` already IS `127.0.0.1` (the "default" profile,
// profileRegistry.ts) to avoid `EADDRINUSE` binding the same address twice.
if (HOST !== "127.0.0.1") {
  const loopbackServer = createServer((req, res) => {
    if (handleBridgeRequest(req, res)) return;
    res.writeHead(404).end();
  });
  // This is the server that actually carries `present_choice`/permission
  // `tools/call` traffic for every profile where it exists (`HOST !==
  // "127.0.0.1"` — i.e. every real deployed profile) — see the
  // matching comment on `httpServer.requestTimeout` above for why this is
  // disabled here too (and why it turned out not to be the real fix).
  loopbackServer.requestTimeout = 0;
  loopbackServer.listen(PORT, "127.0.0.1", () => {
    console.log(`[relay] mcp/permission bridge also listening on http://127.0.0.1:${PORT} (local-only, for own children)`);
  });
}

wss.on("connection", (socket: WebSocket, request) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/terminal") {
    handleTerminalConnection(socket, url, routeContext);
    return;
  }

  if (url.pathname === "/files") {
    handleFilesConnection(socket, url, routeContext);
    return;
  }

  if (url.pathname === "/sessions/watch") {
    sessionListWatchers.add(socket);
    socket.on("close", () => {
      sessionListWatchers.delete(socket);
    });
    return;
  }

  const sessionId = url.searchParams.get("session")?.trim() || DEFAULT_SESSION;

  console.log(`[relay] client connected (session: ${sessionId})`);
  // First thing sent on every connection, ahead of history replay or any
  // other message — a client that finds a mismatch here can refuse to
  // process what follows instead of misinterpreting a vocabulary it
  // doesn't recognize (see protocol/version.ts).
  socket.send(JSON.stringify({ type: "protocol_version", version: WS_PROTOCOL_VERSION }));
  const session = sessionManager.getOrCreate(sessionId);
  session.addClient(socket);

  defaultModelClients.add(socket);
  if (defaultModelInfo) {
    socket.send(
      JSON.stringify({ type: "default_model_state", label: defaultModelInfo.label, available: defaultModelInfo.available }),
    );
  }

  socket.on("message", (raw: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    dispatchChatMessage(session, socket, parsed, (agentId) => sessionManager.setAgent(sessionId, agentId));
  });

  socket.on("close", () => {
    session.removeClient(socket);
    defaultModelClients.delete(socket);
    console.log(`[relay] client disconnected (session: ${sessionId})`);
  });
});

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM", { httpServer, sessionManager }));
process.on("SIGINT", () => void gracefulShutdown("SIGINT", { httpServer, sessionManager }));
