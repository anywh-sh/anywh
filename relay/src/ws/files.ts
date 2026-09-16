import type { WebSocket } from "ws";
import { FilesWatchSession } from "../fs/fsWatch.js";
import { isWatchMessage } from "../protocol/guards.js";
import type { RouteContext } from "../routes/context.js";

/** Work dir file panel's watch — same lifecycle as
 * `/terminal`: connects while the pane is mounted (tab active AND pane
 * open), disconnects on tab switch/pane close/session change. The relay
 * keeps no watcher registry beyond this one connection's own
 * `FilesWatchSession` — everything it opened dies with the socket. */
export function handleFilesConnection(socket: WebSocket, url: URL, ctx: RouteContext): void {
  const chatSessionId = url.searchParams.get("session")?.trim() || ctx.defaultSession;
  const root = ctx.sessionStore.getCwdState(chatSessionId).cwd;

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
