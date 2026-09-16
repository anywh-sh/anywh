import { createReadStream } from "node:fs";
import { isFilesCreateBody, isFilesDeleteBody, isFilesRenameBody } from "../protocol/guards.js";
import { readJsonBody } from "../protocol/httpBody.js";
import { listDirectories } from "../fs/fsBrowse.js";
import {
  createFile,
  deleteFile,
  listFiles,
  readFileForViewer,
  renameFile,
  resolveChatPath,
  resolveRawFile,
  type FilesError,
} from "../fs/fsFiles.js";
import { MAX_UPLOAD_BYTES, readRawBody, saveUpload } from "../fs/uploads.js";
import { defaultCwd } from "../host/paths.js";
import type { RouteHandler } from "./context.js";

function statusForFilesError(error: FilesError | "invalid_name" | "already_exists"): number {
  if (error === "permission_denied") return 403;
  if (error === "not_found") return 404;
  if (error === "already_exists") return 409;
  return 400; // invalid_path, outside_root, invalid_name
}

export const handleFilesRoutes: RouteHandler = async (req, res, ctx) => {
  if (req.method === "GET" && req.url?.startsWith("/fs/list")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const requestedPath = url.searchParams.get("path");
    const result = listDirectories(requestedPath ?? defaultCwd(ctx.homeOverride));
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!result.ok) {
      const status = result.error === "permission_denied" ? 403 : result.error === "not_found" ? 404 : 400;
      res.writeHead(status);
      res.end(JSON.stringify({ error: result.error }));
      return true;
    }
    res.end(JSON.stringify({ path: result.path, entries: result.entries }));
    return true;
  }

  // Work dir file panel — list/read/raw are all rooted at the
  // requesting session's own cwd (`sessionStore.getCwdState`), never a path
  // the client supplies directly; the client only ever sends `session=<id>`
  // plus a path already confirmed to live under that root by a previous
  // response.
  if (req.method === "GET" && req.url?.startsWith("/files/list")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || ctx.defaultSession;
    const rawPath = url.searchParams.get("path");
    const showHidden = url.searchParams.get("all") === "1";
    const root = ctx.sessionStore.getCwdState(sessionId).cwd;
    const result = listFiles(root, rawPath, showHidden);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!result.ok) {
      res.writeHead(statusForFilesError(result.error));
      res.end(JSON.stringify({ error: result.error }));
      return true;
    }
    res.end(JSON.stringify({ root: result.root, path: result.path, entries: result.entries }));
    return true;
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
    const sessionId = url.searchParams.get("session")?.trim() || ctx.defaultSession;
    const rawPath = url.searchParams.get("path");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!rawPath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid_path" }));
      return true;
    }
    const root = ctx.sessionStore.getCwdState(sessionId).cwd;
    res.end(JSON.stringify(resolveChatPath(root, rawPath)));
    return true;
  }

  if (req.method === "GET" && req.url?.startsWith("/files/read")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || ctx.defaultSession;
    const rawPath = url.searchParams.get("path");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!rawPath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid_path" }));
      return true;
    }
    const root = ctx.sessionStore.getCwdState(sessionId).cwd;
    const result = readFileForViewer(root, rawPath);
    if (!result.ok) {
      res.writeHead(statusForFilesError(result.error));
      res.end(JSON.stringify({ error: result.error }));
      return true;
    }
    const body =
      result.kind === "text"
        ? { kind: "text", path: result.path, content: result.content, size: result.size, mtimeMs: result.mtimeMs, truncated: result.truncated }
        : result.kind === "image"
          ? { kind: "image", path: result.path, size: result.size, mtimeMs: result.mtimeMs, mime: result.mime }
          : { kind: "binary", path: result.path, size: result.size, mtimeMs: result.mtimeMs };
    res.end(JSON.stringify(body));
    return true;
  }

  if (req.method === "GET" && req.url?.startsWith("/files/raw")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || ctx.defaultSession;
    const rawPath = url.searchParams.get("path");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!rawPath) {
      res.writeHead(400);
      res.end();
      return true;
    }
    const root = ctx.sessionStore.getCwdState(sessionId).cwd;
    const result = resolveRawFile(root, rawPath);
    if (!result.ok) {
      res.writeHead(statusForFilesError(result.error));
      res.end();
      return true;
    }
    res.setHeader("Content-Type", result.mime);
    createReadStream(result.path).on("error", () => res.end()).pipe(res);
    return true;
  }

  if (req.method === "POST" && req.url?.startsWith("/files/create")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    await readJsonBody(req)
      .then((body) => {
        if (!isFilesCreateBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid_path" }));
          return;
        }
        const root = ctx.sessionStore.getCwdState(body.session?.trim() || ctx.defaultSession).cwd;
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
    return true;
  }

  if (req.method === "POST" && req.url?.startsWith("/files/delete")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    await readJsonBody(req)
      .then((body) => {
        if (!isFilesDeleteBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid_path" }));
          return;
        }
        const root = ctx.sessionStore.getCwdState(body.session?.trim() || ctx.defaultSession).cwd;
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
    return true;
  }

  if (req.method === "POST" && req.url?.startsWith("/files/rename")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    await readJsonBody(req)
      .then((body) => {
        if (!isFilesRenameBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid_path" }));
          return;
        }
        const root = ctx.sessionStore.getCwdState(body.session?.trim() || ctx.defaultSession).cwd;
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
    return true;
  }

  // Drag-and-drop upload into the file panel — same raw-binary-body style as
  // `/upload` (chat attachments), but the destination is the requesting
  // session's own cwd (via `createFile`/`resolveWithinRoot`, same
  // confinement contract as the rest of this route group) rather than the
  // sessionless `RELAY_UPLOAD_DIR`. `dir`/`name` travel in the query string
  // since the body is the raw file bytes, not JSON.
  if (req.method === "POST" && req.url?.startsWith("/files/upload")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || ctx.defaultSession;
    const dir = url.searchParams.get("dir");
    const name = url.searchParams.get("name");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!name) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid_path" }));
      return true;
    }
    const root = ctx.sessionStore.getCwdState(sessionId).cwd;
    await readRawBody(req, MAX_UPLOAD_BYTES)
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
    return true;
  }

  if (req.method === "POST" && req.url?.startsWith("/upload")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const ext = url.searchParams.get("ext") ?? "bin";
    await saveUpload(req, ext)
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
    return true;
  }

  return false;
};
