import type { WebSocket } from "ws";
import { CLAUDE_AGENT_ENV_OVERRIDES } from "../runtimes/defs/claude/index.js";
import { buildChildEnv } from "../host/childEnv.js";
import { EXTRA_PATH_DIRS, stripBilledCredentials } from "../runtimes/executables.js";
import { resolveWithinRoot } from "../fs/fsFiles.js";
import { scrollTerminal, spawnTerminal } from "../host/terminalSession.js";
import { isTerminalInputMessage, isTerminalResizeMessage, isTerminalScrollMessage } from "../protocol/guards.js";
import type { RouteContext } from "../routes/context.js";

/** One interactive shell (tmux) per terminal tab — its own protocol, much
 * simpler than the chat's (no history replay: reattaching to tmux already
 * redraws the screen on its own, see terminalSession.ts). Closing the WS
 * connection (tab/session switch, panel closed, or network drop) only
 * detaches — it never kills the tmux session from here; actually killing it
 * only happens via `POST /terminals/close` (tab explicitly closed) or when
 * the whole chat session is deleted. */
export function handleTerminalConnection(socket: WebSocket, url: URL, ctx: RouteContext): void {
  const chatSessionId = url.searchParams.get("session")?.trim() || ctx.defaultSession;
  const terminalId = url.searchParams.get("term")?.trim();
  if (!terminalId) {
    socket.close();
    return;
  }
  const cols = Number(url.searchParams.get("cols"));
  const rows = Number(url.searchParams.get("rows"));

  const sessionCwd = ctx.sessionStore.getCwdState(chatSessionId).cwd;
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
    env: buildChildEnv(ctx.homeOverride, EXTRA_PATH_DIRS, stripBilledCredentials, CLAUDE_AGENT_ENV_OVERRIDES),
    relayPort: ctx.port,
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
        scrollTerminal(ctx.port, chatSessionId, terminalId, Math.trunc(parsed.lines)).catch((error: unknown) => {
          console.error("[relay] failed to scroll terminal:", error);
        });
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
