import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { McpChoiceBridge } from "./bridges/mcpBridge.js";
import { McpPermissionBridge } from "./bridges/permissionBridge.js";
import { ROOM_BRIDGE_PATH, RoomBridge, roomKeyPathFor } from "./bridges/roomBridge.js";
import { defaultCwd } from "./host/paths.js";
import { extractPdfText } from "./host/pdfText.js";
import { ensureSelfRegistered } from "./host/profileRegistry.js";
import { claudeRuntimeDef } from "./runtimes/defs/claude/index.js";
import { codexRuntimeDef } from "./runtimes/defs/codex.js";
import { buildRegistry } from "./runtimes/registry.js";
import { refreshSelectableAgents } from "./runtimes/selectableAgents.js";
import type { ModelCatalog, RoomAgentSetup } from "./runtimes/types.js";
import { FileCursorStore, HostClient } from "./agentHost/hostClient.js";
import { relayAgentHostSocket } from "./agentHost/paths.js";
import { gracefulShutdown } from "./lifecycle.js";
import { handleAgentRoutes } from "./routes/agents.js";
import { handleFilesRoutes } from "./routes/files.js";
import { handleHostRoutes, setSelectableAgents } from "./routes/host.js";
import { handlePortabilityRoutes } from "./routes/portability.js";
import { handleProfileRoutes } from "./routes/profiles.js";
import { handlePushRoutes } from "./routes/push.js";
import { killAllTerminalsForSession } from "./host/terminalSession.js";
import { handleRoomRoutes } from "./routes/rooms.js";
import { handleRoomWatchConnection } from "./ws/room.js";
import { RoomChannel } from "./session/roomChannel.js";
import { handleSessionRoutes } from "./routes/sessions.js";
import { handleThemeRoutes } from "./routes/themes.js";
import type { RouteContext, RouteHandler } from "./routes/context.js";
import { PushDispatcher } from "./push/dispatcher.js";
import { PushStore } from "./push/pushStore.js";
import { WS_PROTOCOL_VERSION } from "./protocol/version.js";
import { RoomCanvasStore, roomCanvasPathFor } from "./session/roomCanvas.js";
import { RoomWorktrees } from "./session/roomWorktrees.js";
import { WorktreeRegistry, worktreeRegistryPathFor } from "./host/worktreeRegistry.js";
import { RoomContextStore } from "./session/roomContextStore.js";
import { HOST_RUNTIMES, RoomManager } from "./session/roomManager.js";
import { ActivityTrail } from "./session/roomActivity.js";
import { ContextTally } from "./session/roomContextUsage.js";
import { SessionManager } from "./session/sessionManager.js";
import { SessionStore } from "./session/sessionStore.js";
import { dispatchChatMessage } from "./ws/chat.js";
import { handleFilesConnection } from "./ws/files.js";
import { handleMcpLoginConnection } from "./ws/mcpLogin.js";
import { handleTerminalConnection } from "./ws/terminal.js";

// Config via env — allows running one instance per profile (systemd,
// infra/systemd/) without changing code, same as ttyd used to do.
const PORT = Number(process.env.RELAY_PORT ?? 8765);
const HOST = process.env.RELAY_HOST ?? "127.0.0.1";
const HOME_OVERRIDE = process.env.RELAY_HOME_OVERRIDE;
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

// Same reasoning as WAKEUPS_FILE — where the push addresses clients have
// registered live (docs/push.md). `RELAY_PUSH_DISABLED=1` turns the whole
// feature off: no routes, no delivery, local notifications as before.
const PUSH_DEVICES_FILE = process.env.RELAY_PUSH_DEVICES_FILE ?? "./push-devices.local.json";
const PUSH_DISABLED = process.env.RELAY_PUSH_DISABLED === "1";
const pushStore = PUSH_DISABLED ? null : new PushStore(PUSH_DEVICES_FILE);
const pushDispatcher = pushStore ? new PushDispatcher({ store: pushStore }) : null;

const sessionStore = new SessionStore(SESSIONS_FILE, defaultCwd(HOME_OVERRIDE));
// Each room's canvas layout, beside the sessions file (`<profile>-rooms.json`
// for a profile whose sessions file is `<profile>.json`).
const roomCanvas = new RoomCanvasStore(process.env.RELAY_ROOMS_FILE ?? roomCanvasPathFor(SESSIONS_FILE));
// Each room's shared files and their index: a folder per room under the
// profile's home, where the agents (on this machine) can read them.
const roomContext = new RoomContextStore({
  root: process.env.RELAY_ROOM_CONTEXT_DIR ?? join(defaultCwd(HOME_OVERRIDE), ".anywh", "rooms"),
  extractPdf: (path) => extractPdfText(path),
});
// Per room agent: what it read from the model's cache and what it wrote.
const agentContext = new ContextTally();
const roomActivity = new ActivityTrail();
// Always `127.0.0.1`, never `HOST`: this is the address the
// relay's OWN `claude` child processes reach it at, always local to this
// machine (see the comment on `SharedSessionOptions.mcpBridgeBaseUrl`), not
// the address remote clients (possibly over Tailscale) use.
const mcpChoiceBridge = new McpChoiceBridge();
// Separate bridge/path from `mcpChoiceBridge` (own token
// namespace, own route below) even though both are the same "local-only MCP
// server the relay's own `claude` children call into" idea.
const mcpPermissionBridge = new McpPermissionBridge();
// The room tools (`anywh-room`), for the agents of a room — which run in
// the agent host and keep their bridge URL for their whole life, across
// relay restarts (see roomBridge.ts for why its token is not per turn).
const roomBridge = new RoomBridge(process.env.RELAY_ROOM_KEY_FILE ?? roomKeyPathFor(SESSIONS_FILE), `http://127.0.0.1:${PORT}${ROOM_BRIDGE_PATH}`);
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

// This profile's agent host (a separate service that keeps agent processes
// alive across relay restarts). Always connecting in the background: the
// host may start after the relay, or not be installed at all, and neither
// is an error until something actually asks it for work.
// No profile and no explicit socket (a bare `node dist/server.js`): no host.
const agentHostSocket = relayAgentHostSocket();
const agentHost = agentHostSocket ? new HostClient({ socketPath: agentHostSocket, clientName: `relay:${PORT}`, reconnectMaxMs: 10_000 }) : undefined;
agentHost?.start();
if (!agentHost) console.log("[relay] no ANYWH_PROFILE or ANYWH_AGENT_HOST_SOCKET set: not connecting to an agent host");
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
        ? { type: "session_list_upsert", id: event.id, title: event.title, lastActiveAt: event.lastActiveAt, ...(event.room ? { room: true } : {}), ...(event.titlePending ? { titlePending: true } : {}) }
        : { type: "session_list_removed", id: event.id },
    );
    for (const watcher of sessionListWatchers) {
      if (watcher.readyState === watcher.OPEN) watcher.send(payload);
    }
  },
  pushDispatcher ? (event) => pushDispatcher.notify(event) : undefined,
  // `modelCatalogs` is filled by the boot probes below, after this runs.
  (agentId) => modelCatalogs[agentId],
  // A room's workers never hold a tool-permission call open for a person: the
  // request becomes an approval card and the turn ends.
  (id) => (sessionStore.getRoom(id)?.role === "worker" ? { deferredApproval: true } : {}),
  {
    agentHost,
    roomSetup: (id): RoomAgentSetup | undefined => roomManager.setupFor(id),
    admit: (id): string | undefined => roomManager.admit(id),
    onTurnSettled: (id, outcome): void => roomManager.onTurnSettled(id, outcome),
    onRoomDeleted: (roomId) => {
      roomCanvas.delete(roomId);
      roomChannel.closeRoom(roomId);
      roomContext.deleteRoom(roomId);
    },
    onWorkerPrompted: (id, watched): void => roomManager.workerPrompted(id, watched),
    onMemberChanged: (id) => {
      const roomId = sessionStore.getRoom(id)?.roomId;
      if (roomId !== undefined) roomChannel.touch(roomId);
    },
    turnNote: (id) => roomManager.turnNote(id),
    answerRefusal: (id) => roomManager.answerRefusal(id),
    onUsage: (id, event) => agentContext.observe(id, event),
    onActivity: (id, event): void => {
      if (!roomActivity.observe(id, event)) return;
      const roomId = sessionStore.getRoom(id)?.roomId;
      if (roomId !== undefined) roomChannel.touch(roomId);
    },
    onTurnStarted: (id, startedAt, synthetic): void => roomManager.noteTurnStarted(id, startedAt, synthetic),
    onMcpServerUsed: (id, server): void => {
      roomManager.noteConnector(id, server);
      const roomId = sessionStore.getRoom(id)?.roomId;
      if (roomId !== undefined) roomChannel.touch(roomId);
    },
    // How far each room agent's log was read: a turn in flight across a
    // relay restart is picked up from there.
    owner: roomBridge.ownerId,
    onMemberDeleted: (id): void => {
      roomManager.onMemberDeleted(id);
      roomActivity.forget(id);
    },
    cursors: new FileCursorStore(process.env.RELAY_ROOM_CURSORS_FILE ?? roomCanvasPathFor(SESSIONS_FILE).replace(/-rooms\.json$/, "-room-cursors.json")),
  },
);

// Runtimes a room can use: the installed ones the agent host can run. Until
// detection answers, every one the registry has.
let roomRuntimes: readonly string[] = registry.defs.map((def) => def.identity.id).filter((id) => HOST_RUNTIMES.includes(id));
// The worktrees agents create live under the profile's home, outside every
// repository; what the relay created is listed beside the sessions file.
const roomWorktrees = new RoomWorktrees({
  registry: new WorktreeRegistry(process.env.RELAY_WORKTREES_FILE ?? worktreeRegistryPathFor(SESSIONS_FILE)),
  root: process.env.RELAY_WORKTREES_ROOT ?? join(HOME_OVERRIDE ?? homedir(), ".anywh", "worktrees"),
  agents: { facts: (id) => roomManager.worktreeAgentFacts(id) },
});
const roomManager: RoomManager = new RoomManager({
  worktrees: roomWorktrees,
  canvasAreas: (roomId) => roomCanvas.get(roomId).areas,
  store: sessionStore,
  sessions: sessionManager,
  registry,
  bridge: roomBridge,
  runtimes: () => roomRuntimes,
  hostConnected: () => agentHost?.status === "connected",
  deleteAgent: (agentId) => sessionManager.deleteSession(agentId),
  ...(process.env.RELAY_ROOM_REMOVE_UNDO_MS ? { removeUndoMs: Number(process.env.RELAY_ROOM_REMOVE_UNDO_MS) } : {}),
  ...(process.env.RELAY_ROOM_DIGEST_WINDOW_MS ? { digestWindowMs: Number(process.env.RELAY_ROOM_DIGEST_WINDOW_MS) } : {}),
  ...(process.env.RELAY_ROOM_PROMPT_WINDOW_MS ? { promptWindowMs: Number(process.env.RELAY_ROOM_PROMPT_WINDOW_MS) } : {}),
  ...(pushDispatcher ? { notifyPerson: ({ roomId, draft, watched }) => pushDispatcher.notify({ ...draft, sessionId: roomId, ts: Date.now(), watched }) } : {}),
  // A removed agent's subtree is deleted for good: its terminals go with it.
  onPurged: (ids) => {
    for (const id of ids) killAllTerminalsForSession(PORT, id).catch((error: unknown) => console.error("[relay] failed to clean up terminals for a purged agent:", error));
  },
  owner: roomBridge.ownerId,
  tombstonesFile: process.env.RELAY_ROOM_TOMBSTONES_FILE ?? roomCanvasPathFor(SESSIONS_FILE).replace(/-rooms\.json$/, "-room-tombstones.json"),
  stopInHost: async (agentId) => {
    if (!agentHost) throw new Error("this relay has no agent host");
    await agentHost.request("stop", { agentId });
  },
  listHostRoomAgents: async () => {
    if (!agentHost) return [];
    return (await agentHost.request<{ agents: { agentId: string; roomId?: string }[] }>("activity")).agents;
  },
  removeFromHost: async (agentId) => {
    await agentHost?.request("remove", { agentId });
  },
  getModelCatalog: (agentId) => modelCatalogs[agentId],
  context: roomContext,
  ...(process.env.RELAY_ROOM_WARMUP_MS ? { warmUpMs: Number(process.env.RELAY_ROOM_WARMUP_MS) } : {}),
});
roomBridge.attach(roomManager);
// Every room's state on one socket per watcher (`/rooms/:roomId/watch`).
const roomChannel = new RoomChannel({
  // What an agent has just been doing lives here, not in the room's store.
  snapshot: (roomId) => {
    const snapshot = roomManager.snapshot(roomId);
    return snapshot && { ...snapshot, agents: snapshot.agents.map((agent) => ({ ...agent, activity: roomActivity.recent(agent.agentId) })) };
  },
});
sessionStore.onRoomChange((_sessionId, roomId) => roomChannel.touch(roomId));
// Removals that were waiting out their undo window when the relay stopped.
roomManager.sweepRemoved();
// At start, and then daily: finish what a crash interrupted, forget worktrees
// whose folder was deleted, and clean up those of agents gone or done.
const sweepWorktrees = (): void => {
  roomWorktrees
    .sweep()
    .then((outcomes) => {
      const removed = outcomes.filter((outcome) => outcome.result === "removed").length;
      if (removed > 0) console.log(`[relay] removed ${removed} integrated agent worktree(s)`);
    })
    .catch((error: unknown) => console.warn("[relay] worktree sweep failed:", (error as Error).message));
};
// Not before the host has said which turns are running: the sweep takes no
// worktree from under an agent the relay cannot yet see at work.
if (!agentHost) sweepWorktrees();
setInterval(sweepWorktrees, 24 * 60 * 60 * 1000).unref();
// A room's folder outlives nothing: those of rooms the sessions file no
// longer has are removed. Skipped when that file did not load whole (an
// unreadable one would make every room look gone).
// Not for a store with no session at all unless the folder was named by the
// operator: a relay started by hand with default paths would otherwise see
// every room of the profile it shares the folder with as gone.
if (sessionStore.loadedOk && !sessionStore.recoveredFromCorrupt && (sessionStore.listIds().length > 0 || process.env.RELAY_ROOM_CONTEXT_DIR)) {
  const liveRooms = new Set(sessionStore.listIds().filter((id) => sessionStore.getRoom(id)?.role === "principal"));
  const pruned = roomContext.pruneOrphans(liveRooms);
  if (pruned.length > 0) console.log(`[relay] removed the context folders of ${pruned.length} room(s) that no longer exist`);
}
// Every time the relay (re)connects to its host: agents the rooms no longer
// have are removed there, then messages queued before a restart go out.
agentHost?.on("status", (status) => {
  if (status !== "connected") return;
  roomManager
    .reconcileHost()
    .then(
      () => {
        // Only once the host's turns in flight have been picked up: the sweep
        // trusts the sessions' own idea of who is at work.
        roomManager.resumeQueues();
        sweepWorktrees();
      },
      (error: unknown) => {
        console.warn("[relay] could not reconcile the rooms with the agent host:", (error as Error).message);
        roomManager.resumeQueues();
      },
    );
});


const routeContext: RouteContext = {
  sessionStore,
  sessionManager,
  registry,
  homeOverride: HOME_OVERRIDE,
  port: PORT,
  defaultSession: DEFAULT_SESSION,
  pushStore,
  agentHost,
  roomCanvas,
  roomManager,
  roomContext,
  agentContext,
};

// Tried in this order, but order only matters within a group — no two
// groups match overlapping URL prefixes (see docs/architecture.md).
const routeHandlers: readonly RouteHandler[] = [
  handleSessionRoutes,
  handleProfileRoutes,
  handlePortabilityRoutes,
  handleThemeRoutes,
  handleFilesRoutes,
  handleHostRoutes,
  handlePushRoutes,
  handleAgentRoutes,
  handleRoomRoutes,
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
  const roomMatch = req.url?.match(/^\/room\/([^/]+)\/([^/]+)$/);
  if (roomMatch) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(roomMatch[1]);
    } catch {
      // A malformed escape: answered, never thrown out of the request listener.
      res.writeHead(404).end();
      return true;
    }
    void roomBridge.handleRequest(sessionId, roomMatch[2], req, res);
    return true;
  }
  return false;
}

// Each installed agent's model catalog, exactly as its own CLI's picker
// lists it (`probes/modelCatalog.ts`, driven by each def's `models`) —
// probed once at boot, after `detectRuntimes` below says which agents are
// installed, in parallel with everything else (doesn't block
// `httpServer.listen`). Sent per connection rather than per session: the
// client picks the entry for whichever agent the session runs, so a
// session switching agents needs no extra round trip. `modelCatalogClients`
// covers the obvious race — the first client's WS connection almost always
// arrives before the probes resolve — and each catalog is re-sent as it
// lands, so a slow CLI never holds back a fast one.
const modelCatalogs: Record<string, ModelCatalog> = {};
const modelCatalogClients = new Set<WebSocket>();
function sendModelCatalogs(client: WebSocket): void {
  if (Object.keys(modelCatalogs).length === 0) return;
  client.send(JSON.stringify({ type: "model_catalogs_state", catalogs: modelCatalogs }));
}

// Every agent id a client may pick for a session. `detectRuntimes` below
// filters further on `installed`, so a relay without the `codex` binary
// still only ever offers Claude. Extending this list is how the relay
// learns a new agent — same shape as `BILLED_CREDENTIAL_VARS` in
// `runtimes/executables.ts`, which also grows per agent.
const SELECTABLE_AGENT_IDS = ["claude", "codex"];

refreshSelectableAgents({
  defs: [claudeRuntimeDef, codexRuntimeDef],
  selectableIds: SELECTABLE_AGENT_IDS,
  roomRuntimeIds: HOST_RUNTIMES,
  homeOverride: HOME_OVERRIDE,
  cwd: defaultCwd(HOME_OVERRIDE),
  publishSelectable: setSelectableAgents,
  publishRoomRuntimes: (ids) => {
    roomRuntimes = ids;
  },
  publishModelCatalog: (agentId, catalog) => {
    modelCatalogs[agentId] = catalog;
    for (const client of modelCatalogClients) sendModelCatalogs(client);
  },
}).catch((error: unknown) => {
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

// The permission-approval MCP bridge (permissionBridge.ts) holds a
// `tools/call` POST open for as long as a human takes to answer — minutes, not
// milliseconds. (The present_choice bridge, mcpBridge.ts, replies immediately
// now, see the comment on `SharedSession.presentChoice`.) Node's
// `http.Server` has defaulted `requestTimeout` to 300000ms (5 minutes) since
// Node 18: past that, Node itself would abort the request on its own,
// regardless of anything passed to the `claude` child's own `--mcp-config`.
// Disabled here as a guard; it costs nothing for every other route on this
// server, which all respond in milliseconds. The per-server `timeout` in
// `--mcp-config` is what keeps the CLI itself from cutting a pending approval
// (see `buildMcpSpawnConfig`).
httpServer.requestTimeout = 0;

export const wss = new WebSocketServer({ server: httpServer });

// Self-registration waits until every listener this process needs has bound
// (the loopback bridge below too, when HOST is not 127.0.0.1): a relay that
// dies on EADDRINUSE must leave no `default.env` behind. It runs from
// whichever listen callback fires last; with two listeners that order is not
// fixed, so the "listening on" line may be logged before it. The test helpers
// rely on less than that: both run with RELAY_HOST=127.0.0.1, so there is one
// listener and `onBound` runs before that line in the same callback
// (spawnedServer.ts waits for the line; testServer.ts's own 'listening'
// listener is added after this callback). What is done by then is the
// synchronous part of `ensureSelfRegistered`, a fresh write or a skip;
// replacing a stale `default.env` waits on a port probe and lands after.
let pendingBinds = HOST !== "127.0.0.1" ? 2 : 1;
function onBound(): void {
  pendingBinds -= 1;
  if (pendingBinds !== 0) return;
  ensureSelfRegistered({ port: PORT, host: HOST, homeOverride: HOME_OVERRIDE })
    .then((result) => {
      if (result === "replaced") console.log(`[relay] replaced a stale default.env with this relay (port ${PORT})`);
    })
    .catch((error: unknown) => console.error("[relay] self-registration failed:", error));
}

httpServer.listen(PORT, HOST, () => {
  onBound();
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
  // disabled here too.
  loopbackServer.requestTimeout = 0;
  loopbackServer.listen(PORT, "127.0.0.1", () => {
    onBound();
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

  if (url.pathname === "/mcp-login") {
    handleMcpLoginConnection(socket, url, routeContext);
    return;
  }

  const roomWatch = /^\/rooms\/([^/]+)\/watch$/.exec(url.pathname);
  if (roomWatch) {
    let roomId: string;
    try {
      roomId = decodeURIComponent(roomWatch[1]);
    } catch {
      socket.close(4400, "malformed path");
      return;
    }
    handleRoomWatchConnection(socket, roomId, roomChannel);
    return;
  }

  if (url.pathname === "/sessions/watch") {
    sessionListWatchers.add(socket);
    // The whole list, first thing on every connection: a watcher that was
    // disconnected for a while (machine asleep, laptop lid closed, tunnel
    // dropped) missed every upsert/remove in between, and the broadcasts
    // below only ever carry what changed from now on. Sending it here
    // rather than leaving the client to follow up with `GET /sessions`
    // also leaves no gap between the snapshot and the first broadcast.
    socket.send(JSON.stringify({ type: "session_list_snapshot", sessions: sessionManager.listTitled() }));
    // The client's liveness probe (useSessionNames.ts). A socket whose
    // other end vanished without a close frame — the sandbox suspended,
    // the NAT mapping expired — still reads as OPEN on the client
    // forever, and only a reply proves otherwise. Client-initiated on
    // purpose, never a server-side `ws.ping()` on a timer: the pong to
    // that is a frame towards the relay, which a paid host's idle
    // detection counts as someone being there, so a timer here would keep
    // a machine nobody is using awake indefinitely.
    socket.on("message", (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      }
    });
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

  modelCatalogClients.add(socket);
  sendModelCatalogs(socket);

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
    modelCatalogClients.delete(socket);
    console.log(`[relay] client disconnected (session: ${sessionId})`);
  });
});

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM", { httpServer, sessionManager }));
process.on("SIGINT", () => void gracefulShutdown("SIGINT", { httpServer, sessionManager }));
