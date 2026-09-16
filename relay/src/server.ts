import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { buildChildEnv } from "./claudeSession.js";
import { AGENT_BIN } from "./claudeCliConfig.js";
import { detectDefaultModel, type DefaultModelInfo } from "./defaultModel.js";
import { listDirectories } from "./fsBrowse.js";
import type { EditMessageError } from "./sharedSession.js";
import { resolveEditorDescriptor } from "./editorHostInfo.js";
import {
  createFile,
  deleteFile,
  listFiles,
  readFileForViewer,
  renameFile,
  resolveChatPath,
  resolveRawFile,
  resolveWithinRoot,
  type FilesError,
} from "./fsFiles.js";
import { FilesWatchSession } from "./fsWatch.js";
import { readGitStatus } from "./gitStatus.js";
import { defaultCwd, resolveShipped } from "./paths.js";
import {
  deleteProfileFiles,
  ensureSelfRegistered,
  envFileFor,
  findHomeOverrideCollision,
  isValidProfileId,
  listProfiles,
  slugify,
  updateProfileMeta,
} from "./profileRegistry.js";
import { deleteTheme, listThemes, saveTheme, ThemeValidationFailure } from "./themeRegistry.js";
import { isValidThemeId } from "./theme.js";
import { McpChoiceBridge, type ChoiceAnswer } from "./mcpBridge.js";
import { McpPermissionBridge } from "./permissionBridge.js";
import { SessionManager } from "./sessionManager.js";
import { SessionStore, type ModelChoice, type PermissionMode } from "./sessionStore.js";
import { killAllTerminalsForSession, killTerminal, scrollTerminal, spawnTerminal } from "./terminalSession.js";
import { MAX_UPLOAD_BYTES, readRawBody, saveUpload } from "./uploads.js";

// Resolved relative to this file (not hardcoded), same reasoning as
// SCRIPTS_DIR in claudeCliConfig.ts — works running from `src/` (tsx),
// `dist/` (tsc build, two levels below the repo root) or the macOS SEA
// binary (`infra/` shipped flat next to it) alike.
const ADD_PROFILE_SCRIPT = resolveShipped(import.meta.url, "../../infra/systemd/add-profile.sh", "infra/systemd/add-profile.sh");

// Same `resolveShipped` reasoning, one level up: `package.json` sits beside
// `src/`, not inside it, in both shapes this can run as (dev `src/`, or the
// tarball/dist layout `relay_setup.rs::installed_version()` on the client
// side already reads the very same file from). The macOS SEA binary needs
// its own flat copy, added to `sea-build/build.mjs`'s "ships beside the
// binary" list for this.
const PACKAGE_JSON_PATH = resolveShipped(import.meta.url, "../package.json", "package.json");
const RELAY_VERSION = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as { version: string }).version;

// Same seam as `AGENT_BIN` (claudeCliConfig.ts) — defaults to the bare
// command name (works wherever `systemctl --user` is genuinely available),
// overridable so a test never has to shell out to the REAL systemd user
// session, which has no notion of "this is just a test": a real incident
// (2026-09-07) had an integration test's `DELETE /control/profiles/:id`
// call disable+stop the operator's actual live `anywh-relay@trabalho`
// service, SIGKILLing a real in-flight `claude` conversation. `AGENT_BIN`
// already gets this treatment for the same reason; this route's `spawn`
// needed the identical override, not a mock of `spawn` itself.
const SYSTEMCTL_BIN = process.env.SYSTEMCTL_BIN ?? "systemctl";

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

interface UserMessage {
  type: "user_message";
  text: string;
}

function isUserMessage(value: unknown): value is UserMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "user_message" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function isStopTurnMessage(value: unknown): value is { type: "stop_turn" } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "stop_turn";
}

/** Message edit — `fromEnd` counts from the end (`1` = the
 * user's last message). */
function isEditMessageMessage(value: unknown): value is { type: "edit_message"; fromEnd: number; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "edit_message" &&
    typeof (value as { fromEnd?: unknown }).fromEnd === "number" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function isClearConversationMessage(value: unknown): value is { type: "clear_conversation" } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "clear_conversation";
}

function isSetCwdMessage(value: unknown): value is { type: "set_cwd"; path: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "set_cwd" &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

function isSetPermissionModeMessage(value: unknown): value is { type: "set_permission_mode"; mode: PermissionMode } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "set_permission_mode" &&
    PERMISSION_MODES.includes((value as { mode?: unknown }).mode as PermissionMode)
  );
}

// No fixed enum here on purpose — the model catalog is now whatever the
// CLI's own `/model` probe reports (defaultModel.ts), which can grow without
// a relay change. A garbage value just makes the CLI itself reject the turn
// with its own error, same reasoning as the composer's `/model` parsing
// (client/src/lib/slashCommands.ts).
function isSetModelMessage(value: unknown): value is { type: "set_model"; model: ModelChoice } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "set_model" &&
    typeof (value as { model?: unknown }).model === "string" &&
    (value as { model: string }).model.length > 0
  );
}

function isSetDraftMessage(value: unknown): value is { type: "set_draft"; draft: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "set_draft" &&
    typeof (value as { draft?: unknown }).draft === "string"
  );
}

function isRenameBody(value: unknown): value is { id: string; title: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { title?: unknown }).title === "string"
  );
}

function isIdBody(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

function isCreateProfileBody(value: unknown): value is { label: string; home?: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { label?: unknown; home?: unknown };
  return (
    typeof candidate.label === "string" &&
    candidate.label.trim().length > 0 &&
    (candidate.home === undefined || typeof candidate.home === "string")
  );
}

/** `themeId: null` is a meaningful value here (clear the selection, back to
 * the built-in theme), so it can't be folded into "field absent". */
function isPatchProfileBody(value: unknown): value is { label?: string; colorIndex?: number; themeId?: string | null } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { label?: unknown; colorIndex?: unknown; themeId?: unknown };
  if (candidate.label !== undefined && typeof candidate.label !== "string") return false;
  if (candidate.colorIndex !== undefined && typeof candidate.colorIndex !== "number") return false;
  if (candidate.themeId !== undefined && candidate.themeId !== null && typeof candidate.themeId !== "string") return false;
  return candidate.label !== undefined || candidate.colorIndex !== undefined || candidate.themeId !== undefined;
}

function isFilesCreateBody(value: unknown): value is { session?: string; dir?: string | null; name: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; dir?: unknown };
  return typeof candidate.name === "string" && (candidate.dir === undefined || candidate.dir === null || typeof candidate.dir === "string");
}

function isFilesDeleteBody(value: unknown): value is { session?: string; path: string } {
  return typeof value === "object" && value !== null && typeof (value as { path?: unknown }).path === "string";
}

function isFilesRenameBody(value: unknown): value is { session?: string; path: string; newName: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { newName?: unknown }).newName === "string"
  );
}

function isTerminalCloseBody(value: unknown): value is { session: string; term: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { session?: unknown }).session === "string" &&
    typeof (value as { term?: unknown }).term === "string"
  );
}

function isTerminalInputMessage(value: unknown): value is { type: "input"; data: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "input" &&
    typeof (value as { data?: unknown }).data === "string"
  );
}

/** Paginated history — request for turns older than the
 * initial tail, triggered by the user scrolling up in the UI. */
function isLoadOlderHistoryMessage(value: unknown): value is { type: "load_older_history"; beforeCursor: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "load_older_history" &&
    typeof (value as { beforeCursor?: unknown }).beforeCursor === "number"
  );
}

/** Cancellation of an `anywh-bg` job requested by the UI. */
function isCancelBackgroundJobMessage(value: unknown): value is { type: "cancel_background_job"; id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "cancel_background_job" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

function isChoiceAnswerMessage(value: unknown): value is { type: "choice_answer"; promptId: string; answers: ChoiceAnswer[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "choice_answer" &&
    typeof (value as { promptId?: unknown }).promptId === "string" &&
    Array.isArray((value as { answers?: unknown }).answers)
  );
}

function isTerminalResizeMessage(value: unknown): value is { type: "resize"; cols: number; rows: number } {
  if (typeof value !== "object" || value === null || (value as { type?: unknown }).type !== "resize") return false;
  const cols = (value as { cols?: unknown }).cols;
  const rows = (value as { rows?: unknown }).rows;
  return typeof cols === "number" && cols > 0 && typeof rows === "number" && rows > 0;
}

/** Mouse wheel over the embedded terminal — see `scrollTerminal` in
 * terminalSession.ts for why this drives tmux's `copy-mode` directly instead
 * of just being handled by xterm.js locally. `lines` is signed: positive
 * scrolls up (older content), negative scrolls down. */
function statusForFilesError(error: FilesError | "invalid_name" | "already_exists"): number {
  if (error === "permission_denied") return 403;
  if (error === "not_found") return 404;
  if (error === "already_exists") return 409;
  return 400; // invalid_path, outside_root, invalid_name
}

/** Work dir file panel's watch — always the client's full
 * current set of visible dirs/files, never an incremental add/remove (see
 * `FilesWatchSession`). */
function isWatchMessage(value: unknown): value is { type: "watch"; dirs: string[]; files: string[] } {
  if (typeof value !== "object" || value === null || (value as { type?: unknown }).type !== "watch") return false;
  const dirs = (value as { dirs?: unknown }).dirs;
  const files = (value as { files?: unknown }).files;
  return Array.isArray(dirs) && dirs.every((d) => typeof d === "string") && Array.isArray(files) && files.every((f) => typeof f === "string");
}

function isTerminalScrollMessage(value: unknown): value is { type: "scroll"; lines: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "scroll" &&
    typeof (value as { lines?: unknown }).lines === "number"
  );
}

/** Every JSON route here took a body of a handful of fields, so a cap never
 * mattered; a theme file is the first body that comes from a file the user
 * picked, which is exactly the case where "accumulate until the client stops
 * sending" is not acceptable. Generous enough that no real theme is near it
 * (mirrors MAX_THEME_BYTES in themeRegistry.ts). */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** No body-parsing lib in the project (only the binary upload had a chunk
 * accumulator, `uploads.ts`) — the rename body is small enough (an id + a
 * title) that it doesn't justify pulling in a dependency just for this. */
function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        // Destroying is what stops the upload; without it the sender keeps
        // streaming into a request nobody is reading anymore.
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
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

/** Same as `readJsonBody`, but an empty/absent body is valid here (means
 * "use the real $HOME") rather than a 400 — unlike every other route below,
 * `/control/profiles/validate`'s whole body is optional. */
function readOptionalJsonBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return readJsonBody(req)
    .then((value) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}))
    .catch(() => ({}));
}

const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 5000;

interface ClaudeAuthStatus {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
}

/** Runs `claude auth status --json` under the given `$HOME` — reuses
 * `buildChildEnv` (strips `ANTHROPIC_API_KEY`, patches `PATH`) for the exact
 * reason a real turn does: without the `PATH` patch the binary isn't found
 * under systemd's minimal `PATH`, and with `ANTHROPIC_API_KEY` present this
 * would report `loggedIn: true` via API key — the false positive this check
 * exists to prevent. */
function runClaudeAuthStatus(homeOverride: string | undefined): Promise<ClaudeAuthStatus> {
  return new Promise((resolveStatus, rejectStatus) => {
    const child = spawn(AGENT_BIN, ["auth", "status", "--json"], { env: buildChildEnv(homeOverride) });
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectStatus(new Error("claude auth status timed out"));
    }, CLAUDE_AUTH_STATUS_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectStatus(error);
    });
    child.on("close", () => {
      clearTimeout(timeout);
      try {
        resolveStatus(JSON.parse(stdout) as ClaudeAuthStatus);
      } catch (error) {
        rejectStatus(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

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
// Sockets connected to `/sessions/watch` (client/src/hooks/useSessionNames.ts)
// — one per device showing the sidebar, independent of which session tabs
// (if any) it has open. `SessionManager` doesn't know about WebSocket at
// all; it just reports list changes through `onListChanged` below, and this
// is where they get fanned out.
const sessionListWatchers = new Set<WebSocket>();
const sessionManager = new SessionManager(
  HOME_OVERRIDE,
  sessionStore,
  BACKGROUND_JOBS_FILE,
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

// `true` from the first SIGTERM/SIGINT received onward — rejects a new turn
// (see `isUserMessage` above) while `gracefulShutdown` waits for turns
// already in progress to finish, see the definition at the end of the file.
let shuttingDown = false;

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

// Exported so integration tests (relay/tests/) can close both servers in
// teardown — this module runs its listen/connection wiring as a side effect
// of being imported, so a test that imports it needs a handle to shut it
// down again without killing the whole process.
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

  if (req.method === "GET" && req.url?.startsWith("/sessions")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({ sessions: sessionManager.listTitled() }));
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/sessions/rename")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    readJsonBody(req)
      .then((body) => {
        const title = isRenameBody(body) ? body.title.trim() : "";
        if (!isRenameBody(body) || !title) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "id and a non-empty title are required" }));
          return;
        }
        const ok = sessionManager.renameTitle(body.id, title);
        if (!ok) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "session not found" }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/sessions/delete")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    readJsonBody(req)
      .then((body) => {
        if (!isIdBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "id is required" }));
          return;
        }
        const ok = sessionManager.deleteSession(body.id);
        if (!ok) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "session not found" }));
          return;
        }
        // Sweeps and kills any terminal (tmux) this chat session still had
        // open — without this it would stay orphaned forever, with no tab in
        // the UI aware it exists (see terminalSession.ts).
        killAllTerminalsForSession(PORT, body.id)
          .catch((error: unknown) => console.error("[relay] failed to clean up terminals for deleted session:", error))
          .finally(() => res.end(JSON.stringify({ ok: true })));
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/terminals/close")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    readJsonBody(req)
      .then((body) => {
        if (!isTerminalCloseBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "session and term are required" }));
          return;
        }
        killTerminal(PORT, body.session, body.term)
          .then(() => res.end(JSON.stringify({ ok: true })))
          .catch((error: unknown) => {
            console.error("[relay] failed to close terminal:", error);
            res.writeHead(500);
            res.end(JSON.stringify({ error: "failed to close terminal" }));
          });
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return;
  }

  // Themes are registered per host, not per profile (themeRegistry.ts): the
  // same custom theme has to be selectable from every profile, and every
  // device that syncs against this host sees the same list. Which theme a
  // given profile uses is `themeId` on its own metadata, patched through
  // the profiles route below.
  if (req.method === "GET" && req.url === "/control/themes") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      res.end(JSON.stringify({ themes: listThemes() }));
    } catch (error) {
      console.error("[relay] failed to list themes:", error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "failed to list themes" }));
    }
    return;
  }

  if (req.method === "PUT" && req.url?.startsWith("/control/themes/")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const id = decodeURIComponent(req.url.slice("/control/themes/".length).split("?")[0]);
    // The id becomes a filename, so it's checked before anything reaches the
    // filesystem — `saveTheme` validates the body's own id again, but the
    // path here would be built from this one either way.
    if (!isValidThemeId(id)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid theme id" }));
      return;
    }
    readJsonBody(req)
      .then((body) => {
        if (typeof body !== "object" || body === null || (body as { id?: unknown }).id !== id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "theme id does not match the url" }));
          return;
        }
        try {
          res.end(JSON.stringify(saveTheme(body)));
        } catch (error) {
          if (error instanceof ThemeValidationFailure) {
            // The per-field errors travel back so the import UI can point at
            // the offending line instead of saying "invalid theme".
            res.writeHead(422);
            res.end(JSON.stringify({ error: "invalid theme", errors: error.errors }));
            return;
          }
          console.error("[relay] failed to save theme:", error);
          res.writeHead(500);
          res.end(JSON.stringify({ error: "failed to save theme" }));
        }
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return;
  }

  if (req.method === "DELETE" && req.url?.startsWith("/control/themes/")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const id = decodeURIComponent(req.url.slice("/control/themes/".length).split("?")[0]);
    try {
      if (!deleteTheme(id)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "theme not found" }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      console.error("[relay] failed to delete theme:", error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "failed to delete theme" }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/control/profiles")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    listProfiles()
      .then((profiles) => res.end(JSON.stringify({ profiles })))
      .catch((error: unknown) => {
        console.error("[relay] failed to list profiles:", error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: "failed to list profiles" }));
      });
    return;
  }

  if (req.method === "POST" && req.url === "/control/profiles") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    readJsonBody(req)
      .then(async (body) => {
        if (!isCreateProfileBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "label is required" }));
          return;
        }
        const homeOverride = body.home && body.home.length > 0 ? body.home : undefined;

        // Re-validated here, not trusted from an earlier `/validate` call by
        // the same client: another device could have registered a
        // colliding profile in between, and the client can't have checked
        // login for a `homeOverride` it just typed without a round trip
        // anyway.
        let status: ClaudeAuthStatus;
        try {
          status = await runClaudeAuthStatus(homeOverride);
        } catch (error) {
          console.error("[relay] claude auth status check failed:", error);
          res.writeHead(502);
          res.end(JSON.stringify({ error: "failed to check claude auth status" }));
          return;
        }
        if (!status.loggedIn) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: "not logged in" }));
          return;
        }
        const collidesWith = findHomeOverrideCollision(homeOverride);
        if (collidesWith) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: "home already registered", collidesWith }));
          return;
        }

        const existingIds = (await listProfiles()).map((profile) => profile.id);
        const id = slugify(body.label, existingIds);

        const args = [id, "--label", body.label, "--mode", "prod"];
        if (homeOverride) args.push("--home", homeOverride);

        // Argv array, no shell: `id` is derived from user-supplied `label`
        // text and becomes a filename and a systemd instance name — a
        // shell would let a stray space or `/` in that text break out of
        // the intended single argument.
        const child = spawn(ADD_PROFILE_SCRIPT, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("error", (error) => {
          console.error("[relay] failed to run add-profile.sh:", error);
          res.writeHead(500);
          res.end(JSON.stringify({ error: "failed to provision profile" }));
        });
        child.on("close", (code) => {
          if (code !== 0) {
            console.error("[relay] add-profile.sh exited with code", code, stderr || stdout);
            res.writeHead(500);
            res.end(JSON.stringify({ error: "failed to provision profile", details: stderr || stdout }));
            return;
          }
          listProfiles()
            .then((profiles) => {
              const created = profiles.find((profile) => profile.id === id);
              if (!created) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: "profile provisioned but not found in registry" }));
                return;
              }
              res.end(
                JSON.stringify({
                  id: created.id,
                  label: created.label,
                  host: created.host,
                  port: created.port,
                  colorIndex: created.colorIndex,
                }),
              );
            })
            .catch((error: unknown) => {
              console.error("[relay] failed to re-read profiles after provisioning:", error);
              res.writeHead(500);
              res.end(JSON.stringify({ error: "profile provisioned but failed to read it back" }));
            });
        });
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/control/profiles/validate")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    readOptionalJsonBody(req).then(async (body) => {
      const homeOverride = typeof body.homeOverride === "string" && body.homeOverride.length > 0 ? body.homeOverride : undefined;
      let status: ClaudeAuthStatus;
      try {
        status = await runClaudeAuthStatus(homeOverride);
      } catch (error) {
        console.error("[relay] claude auth status check failed:", error);
        res.writeHead(502);
        res.end(JSON.stringify({ error: "failed to check claude auth status" }));
        return;
      }
      const collidesWith = findHomeOverrideCollision(homeOverride);
      res.end(JSON.stringify(collidesWith ? { ...status, collidesWith } : status));
    });
    return;
  }

  if (req.method === "PATCH" && req.url?.startsWith("/control/profiles/")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const id = decodeURIComponent(req.url.slice("/control/profiles/".length).split("?")[0]);
    readJsonBody(req)
      .then((body) => {
        if (!isPatchProfileBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "label or colorIndex is required" }));
          return;
        }
        try {
          res.end(JSON.stringify(updateProfileMeta(id, body)));
        } catch (error) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "profile not found" }));
        }
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return;
  }

  if (req.method === "DELETE" && req.url?.startsWith("/control/profiles/")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const id = decodeURIComponent(req.url.slice("/control/profiles/".length).split("?")[0]);
    if (!isValidProfileId(id) || !existsSync(envFileFor(id))) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "profile not found" }));
      return;
    }

    // The caller is responsible for never sending this to the profile it's
    // deleting — `systemctl --user disable --now` would
    // stop this very process mid-request. Best-effort: a profile created
    // with `add-profile.sh --mode dev` was never a systemd instance, so a
    // failure here doesn't block cleaning up the registry below.
    const finishDelete = () => {
      try {
        deleteProfileFiles(id);
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        console.error("[relay] failed to delete profile files:", error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: "failed to delete profile files" }));
      }
    };
    const disable = spawn(SYSTEMCTL_BIN, ["--user", "disable", "--now", `anywh-relay@${id}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let disableStderr = "";
    disable.stderr.on("data", (chunk: Buffer) => (disableStderr += chunk.toString("utf8")));
    disable.on("error", (error) => {
      console.error("[relay] failed to run systemctl disable for", id, ":", error);
      finishDelete();
    });
    disable.on("close", (code) => {
      if (code !== 0) console.error("[relay] systemctl disable for", id, "exited", code, disableStderr.trim());
      finishDelete();
    });
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/fs/list")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const requestedPath = url.searchParams.get("path");
    const result = listDirectories(requestedPath ?? defaultCwd(HOME_OVERRIDE));
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!result.ok) {
      const status = result.error === "permission_denied" ? 403 : result.error === "not_found" ? 404 : 400;
      res.writeHead(status);
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    res.end(JSON.stringify({ path: result.path, entries: result.entries }));
    return;
  }

  // Work dir file panel — list/read/raw are all rooted at the
  // requesting session's own cwd (`sessionStore.getCwdState`), never a path
  // the client supplies directly; the client only ever sends `session=<id>`
  // plus a path already confirmed to live under that root by a previous
  // response.
  if (req.method === "GET" && req.url?.startsWith("/files/list")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || DEFAULT_SESSION;
    const rawPath = url.searchParams.get("path");
    const showHidden = url.searchParams.get("all") === "1";
    const root = sessionStore.getCwdState(sessionId).cwd;
    const result = listFiles(root, rawPath, showHidden);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!result.ok) {
      res.writeHead(statusForFilesError(result.error));
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    res.end(JSON.stringify({ root: result.root, path: result.path, entries: result.entries }));
    return;
  }

  // Path mentioned in chat text (`MarkdownContent`'s `code` override) —
  // unlike the other `/files/*` routes, `path` here is never something a
  // previous response already confirmed lives under the root; it's the
  // model's raw prose, which may be a bare filename, a wrong last segment,
  // or already-absolute. Always 200 (never a `FilesError` status): even a
  // path resolving to nothing is a normal outcome the client acts on
  // (`existingDirs`), not an error condition.
  if (req.method === "GET" && req.url?.startsWith("/files/resolve")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || DEFAULT_SESSION;
    const rawPath = url.searchParams.get("path");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!rawPath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid_path" }));
      return;
    }
    const root = sessionStore.getCwdState(sessionId).cwd;
    res.end(JSON.stringify(resolveChatPath(root, rawPath)));
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/files/read")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || DEFAULT_SESSION;
    const rawPath = url.searchParams.get("path");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!rawPath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid_path" }));
      return;
    }
    const root = sessionStore.getCwdState(sessionId).cwd;
    const result = readFileForViewer(root, rawPath);
    if (!result.ok) {
      res.writeHead(statusForFilesError(result.error));
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    const body =
      result.kind === "text"
        ? { kind: "text", path: result.path, content: result.content, size: result.size, mtimeMs: result.mtimeMs, truncated: result.truncated }
        : result.kind === "image"
          ? { kind: "image", path: result.path, size: result.size, mtimeMs: result.mtimeMs, mime: result.mime }
          : { kind: "binary", path: result.path, size: result.size, mtimeMs: result.mtimeMs };
    res.end(JSON.stringify(body));
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/files/raw")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || DEFAULT_SESSION;
    const rawPath = url.searchParams.get("path");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!rawPath) {
      res.writeHead(400);
      res.end();
      return;
    }
    const root = sessionStore.getCwdState(sessionId).cwd;
    const result = resolveRawFile(root, rawPath);
    if (!result.ok) {
      res.writeHead(statusForFilesError(result.error));
      res.end();
      return;
    }
    res.setHeader("Content-Type", result.mime);
    createReadStream(result.path).on("error", () => res.end()).pipe(res);
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/files/create")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    readJsonBody(req)
      .then((body) => {
        if (!isFilesCreateBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid_path" }));
          return;
        }
        const root = sessionStore.getCwdState(body.session?.trim() || DEFAULT_SESSION).cwd;
        const result = createFile(root, body.dir ?? null, body.name);
        if (!result.ok) {
          res.writeHead(statusForFilesError(result.error));
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.end(JSON.stringify({ ok: true, path: result.path }));
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/files/delete")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    readJsonBody(req)
      .then((body) => {
        if (!isFilesDeleteBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid_path" }));
          return;
        }
        const root = sessionStore.getCwdState(body.session?.trim() || DEFAULT_SESSION).cwd;
        const result = deleteFile(root, body.path);
        if (!result.ok) {
          res.writeHead(statusForFilesError(result.error));
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/files/rename")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    readJsonBody(req)
      .then((body) => {
        if (!isFilesRenameBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid_path" }));
          return;
        }
        const root = sessionStore.getCwdState(body.session?.trim() || DEFAULT_SESSION).cwd;
        const result = renameFile(root, body.path, body.newName);
        if (!result.ok) {
          res.writeHead(statusForFilesError(result.error));
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.end(JSON.stringify({ ok: true, path: result.path }));
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return;
  }

  // Drag-and-drop upload into the file panel — same raw-binary-body style as
  // `/upload` (chat attachments), but the destination is the requesting
  // session's own cwd (via `createFile`/`resolveWithinRoot`, same
  // confinement contract as the rest of this route group) rather than the
  // sessionless `RELAY_UPLOAD_DIR`. `dir`/`name` travel in the query string
  // since the body is the raw file bytes, not JSON.
  if (req.method === "POST" && req.url?.startsWith("/files/upload")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || DEFAULT_SESSION;
    const dir = url.searchParams.get("dir");
    const name = url.searchParams.get("name");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!name) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid_path" }));
      return;
    }
    const root = sessionStore.getCwdState(sessionId).cwd;
    readRawBody(req, MAX_UPLOAD_BYTES)
      .then((buffer) => {
        const result = createFile(root, dir, name, buffer);
        if (!result.ok) {
          res.writeHead(statusForFilesError(result.error));
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.end(JSON.stringify({ ok: true, path: result.path }));
      })
      .catch((error: unknown) => {
        console.error("[relay] files upload failed:", error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: "upload failed" }));
      });
    return;
  }

  // Tells the client whether/how it can open a file-panel path in a local
  // editor — see editorHostInfo.ts for why locality is declared
  // via env rather than inferred, and why the peer address is only a
  // downgrade guard on top of that declaration.
  if (req.method === "GET" && req.url === "/host-info") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const editor = resolveEditorDescriptor(process.env, req.socket.remoteAddress);
    // `version` is new — an older relay simply omits it, and the client's
    // type for this field is optional for exactly that reason. Populating
    // it now, ahead of any UI reading it, is what lets that UI eventually
    // warn about drift: every relay already in the field today has none,
    // and it takes an actual round of upgrades before this is useful at all.
    res.end(JSON.stringify({ hostname: hostname(), platform: process.platform, editor, version: RELAY_VERSION }));
    return;
  }

  // The status bar's left half — the branch and change count of whatever
  // repository the session's cwd happens to sit in. Session-scoped like the
  // `/files/*` routes above (the client sends an id, never a path), and
  // deliberately cheap to be wrong about: a cwd outside a repository, a host
  // without git, or a call that times out all answer `{ repo: false }` with
  // a 200, because the segment simply disappears (see gitStatus.ts).
  if (req.method === "GET" && req.url?.startsWith("/git/status")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || DEFAULT_SESSION;
    const cwd = sessionStore.getCwdState(sessionId).cwd;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    readGitStatus(cwd)
      .then((status) => {
        res.end(JSON.stringify(status));
      })
      .catch(() => {
        // `readGitStatus` is documented never to reject; this keeps a broken
        // promise from leaving the request hanging anyway.
        res.end(JSON.stringify({ repo: false }));
      });
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/upload")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const ext = url.searchParams.get("ext") ?? "bin";
    saveUpload(req, ext)
      .then((result) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(JSON.stringify(result));
      })
      .catch((error: unknown) => {
        console.error("[relay] upload failed:", error);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.writeHead(500);
        res.end(String(error instanceof Error ? error.message : error));
      });
    return;
  }

  res.writeHead(426);
  res.end();
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
// in Fase 1-3, only in isolated tests against a bare `127.0.0.1`-bound
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

/** One interactive shell (tmux) per terminal tab — its own protocol, much
 * simpler than the chat's (no history replay: reattaching to tmux already
 * redraws the screen on its own, see terminalSession.ts). Closing the WS
 * connection (tab/session switch, panel closed, or network drop) only
 * detaches — it never kills the tmux session from here; actually killing it
 * only happens via `POST /terminals/close` (tab explicitly closed) or when
 * the whole chat session is deleted. */
function handleTerminalConnection(socket: WebSocket, url: URL): void {
  const chatSessionId = url.searchParams.get("session")?.trim() || DEFAULT_SESSION;
  const terminalId = url.searchParams.get("term")?.trim();
  if (!terminalId) {
    socket.close();
    return;
  }
  const cols = Number(url.searchParams.get("cols"));
  const rows = Number(url.searchParams.get("rows"));

  const sessionCwd = sessionStore.getCwdState(chatSessionId).cwd;
  // "Open in terminal" (the file tree's action) — an optional starting
  // directory, confined to the session's own root the same way `/files/*`
  // is (not a security boundary, see `resolveWithinRoot`'s own comment —
  // just a contract that a UI bug can't point a fresh tmux session at
  // something like `/etc`). Falls back to the session's cwd instead of
  // erroring: only matters on first spawn (`spawnTerminal`'s own doc
  // comment — reattaching via `-A` ignores `cwd` entirely), so failing the
  // whole terminal connection over a stale/invalid path would be a worse
  // experience than just landing in the usual place.
  const rawCwd = url.searchParams.get("cwd");
  const resolvedCwd = rawCwd ? resolveWithinRoot(sessionCwd, rawCwd) : null;
  const cwd = resolvedCwd?.ok ? resolvedCwd.path : sessionCwd;
  const term = spawnTerminal({
    homeOverride: HOME_OVERRIDE,
    relayPort: PORT,
    chatSessionId,
    terminalId,
    cwd,
    cols: Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 80,
    rows: Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24,
  });

  const dataSub = term.onData((data) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "data", data }));
  });
  const exitSub = term.onExit(({ exitCode }) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "exit", code: exitCode }));
  });

  socket.on("message", (raw: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (isTerminalInputMessage(parsed)) {
        term.write(parsed.data);
      } else if (isTerminalResizeMessage(parsed)) {
        term.resize(Math.floor(parsed.cols), Math.floor(parsed.rows));
      } else if (isTerminalScrollMessage(parsed)) {
        scrollTerminal(PORT, chatSessionId, terminalId, Math.trunc(parsed.lines));
      }
    } catch (error) {
      // `term.write`/`term.resize` call ioctl on the pty's fd under the
      // hood — a real finding from running the app: a message in transit
      // (e.g. a debounced resize) can arrive after the pty has already died
      // (the socket's `close` already ran `term.kill()`, or the process
      // exited on its own), throwing a synchronous exception (`EBADF`).
      // Without this try/catch, this wouldn't stay contained to this
      // terminal tab — it would take down the WHOLE relay process (an
      // uncaught exception inside an EventEmitter's handler), along with
      // every chat session connected to it. Dropping the message is safe:
      // the terminal client will reconnect on its own if the pty really did die.
      console.error("[relay] discarding terminal message, pty possibly already dead:", error);
    }
  });

  socket.on("close", () => {
    dataSub.dispose();
    exitSub.dispose();
    term.kill();
  });
}

/** Work dir file panel's watch — same lifecycle as
 * `/terminal`: connects while the pane is mounted (tab active AND pane
 * open), disconnects on tab switch/pane close/session change. The relay
 * keeps no watcher registry beyond this one connection's own
 * `FilesWatchSession` — everything it opened dies with the socket. */
function handleFilesConnection(socket: WebSocket, url: URL): void {
  const chatSessionId = url.searchParams.get("session")?.trim() || DEFAULT_SESSION;
  const root = sessionStore.getCwdState(chatSessionId).cwd;

  const watchSession = new FilesWatchSession(root, (message) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  });

  socket.on("message", (raw: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (isWatchMessage(parsed)) watchSession.update(parsed.dirs, parsed.files);
  });

  socket.on("close", () => {
    watchSession.close();
  });
}

wss.on("connection", (socket: WebSocket, request) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/terminal") {
    handleTerminalConnection(socket, url);
    return;
  }

  if (url.pathname === "/files") {
    handleFilesConnection(socket, url);
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
    if (isStopTurnMessage(parsed)) {
      session.stopTurn();
      return;
    }
    if (isClearConversationMessage(parsed)) {
      session.clearConversation();
      return;
    }
    if (isSetCwdMessage(parsed)) {
      const result = session.setCwd(parsed.path);
      if (!result.ok) socket.send(JSON.stringify({ type: "set_cwd_error", code: result.error }));
      return;
    }
    if (isSetPermissionModeMessage(parsed)) {
      session.setPermissionMode(parsed.mode);
      return;
    }
    if (isSetModelMessage(parsed)) {
      session.setModel(parsed.model);
      return;
    }
    if (isSetDraftMessage(parsed)) {
      session.setDraft(parsed.draft);
      return;
    }
    if (isLoadOlderHistoryMessage(parsed)) {
      session.loadOlderHistory(socket, parsed.beforeCursor);
      return;
    }
    if (isChoiceAnswerMessage(parsed)) {
      session.answerChoice(parsed.promptId, parsed.answers);
      return;
    }
    if (isCancelBackgroundJobMessage(parsed)) {
      session.cancelBackgroundJob(parsed.id);
      return;
    }
    if (isEditMessageMessage(parsed)) {
      if (shuttingDown) {
        socket.send(JSON.stringify({ type: "edit_message_error", code: "relay_restarting" satisfies EditMessageError }));
        return;
      }
      session.editMessage(socket, parsed.fromEnd, parsed.text);
      return;
    }
    if (!isUserMessage(parsed)) {
      console.warn("[relay] message ignored, unexpected format:", parsed);
      return;
    }
    if (shuttingDown) {
      socket.send(JSON.stringify({ type: "turn_error", message: "relay reiniciando, tente de novo em instantes" }));
      return;
    }
    session.submitTurn(socket, parsed.text);
  });

  socket.on("close", () => {
    session.removeClient(socket);
    defaultModelClients.delete(socket);
    console.log(`[relay] client disconnected (session: ${sessionId})`);
  });
});

// How long to wait for turn(s) in progress to finish on their own before
// giving up and aborting via SIGINT (see below) — generous on purpose
// (long responses exist), but configurable so adjusting it doesn't require
// a rebuild. The systemd unit's `TimeoutStopSec` needs to stay GREATER than
// this + `SHUTDOWN_ABORT_GRACE_MS`, otherwise systemd sends SIGKILL to the
// whole cgroup before we even finish waiting.
const SHUTDOWN_GRACE_MS = Number(process.env.RELAY_SHUTDOWN_GRACE_MS ?? 4 * 60 * 1000);
// After the fallback SIGINT (same path as the "Stop" button — tested
// against the real binary, exits cleanly with a valid `result`), how long
// to wait for the `claude -p` process to actually finish before exiting anyway.
const SHUTDOWN_ABORT_GRACE_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SIGTERM (`systemctl restart`/`stop`) or SIGINT (Ctrl+C in dev) — by
 * default systemd (`KillMode=control-group`, deliberately not used here,
 * see infra/systemd/) would send the signal to the child `claude -p`
 * process at the same time as the relay, killing a turn in progress raw
 * (only the SIGINT sent by the "Stop" button was validated as a clean exit,
 * not SIGTERM). With `KillMode=mixed` on the unit, only the relay receives
 * the signal — this function stops accepting new connections and new
 * turns, waits for turns already in progress to finish on their own, and
 * only resorts to SIGINT (`stopTurn`, same path as the "Stop" button) if
 * one gets stuck past the grace period.
 */
async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[relay] ${signal} received — no longer accepting new connections, waiting for turn(s) in progress...`);
  httpServer.close();

  const idle = sessionManager.waitForAllIdle();
  const timedOut = await Promise.race([idle.then(() => false), delay(SHUTDOWN_GRACE_MS).then(() => true)]);

  if (timedOut) {
    console.warn(
      `[relay] turn(s) still in progress after ${SHUTDOWN_GRACE_MS}ms — aborting with SIGINT (same path as the "Stop" button) before exiting.`,
    );
    sessionManager.stopAllTurns();
    await Promise.race([idle, delay(SHUTDOWN_ABORT_GRACE_MS)]);
  }

  console.log("[relay] exiting.");
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
