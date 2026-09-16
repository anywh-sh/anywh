import { isIdBody, isRenameBody } from "../protocol/guards.js";
import { readJsonBody } from "../protocol/httpBody.js";
import { killAllTerminalsForSession } from "../host/terminalSession.js";
import type { RouteHandler } from "./context.js";

export const handleSessionRoutes: RouteHandler = async (req, res, ctx) => {
  if (req.method === "GET" && req.url?.startsWith("/sessions")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({ sessions: ctx.sessionManager.listTitled() }));
    return true;
  }

  if (req.method === "POST" && req.url?.startsWith("/sessions/rename")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    await readJsonBody(req)
      .then((body) => {
        const title = isRenameBody(body) ? body.title.trim() : "";
        if (!isRenameBody(body) || !title) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "id and a non-empty title are required" }));
          return;
        }
        const ok = ctx.sessionManager.renameTitle(body.id, title);
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
    return true;
  }

  if (req.method === "POST" && req.url?.startsWith("/sessions/delete")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    await readJsonBody(req)
      .then((body) => {
        if (!isIdBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "id is required" }));
          return;
        }
        const ok = ctx.sessionManager.deleteSession(body.id);
        if (!ok) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "session not found" }));
          return;
        }
        // Sweeps and kills any terminal (tmux) this chat session still had
        // open — without this it would stay orphaned forever, with no tab in
        // the UI aware it exists (see terminalSession.ts).
        killAllTerminalsForSession(ctx.port, body.id)
          .catch((error: unknown) => console.error("[relay] failed to clean up terminals for deleted session:", error))
          .finally(() => res.end(JSON.stringify({ ok: true })));
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return true;
  }

  return false;
};
