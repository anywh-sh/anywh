import { readJsonBody } from "../protocol/httpBody.js";
import type { RouteHandler } from "./context.js";

const STATUS_BY_CODE = { unsupported: 409, bad_version: 400, not_newer: 409, busy: 409, start_failed: 500 } as const;

/**
 * The relay's self-update (update/relayUpdater.ts):
 *   GET  /relay/update                 → where an update stands
 *   POST /relay/update {version}       → install that release over this one
 * The app asks with its own version when it finds this relay older; the new
 * release runs from the relay's next restart, which happens on its own once
 * no turn is in flight (update/releaseWatch.ts).
 */
export const handleUpdateRoutes: RouteHandler = async (req, res, ctx) => {
  if (req.url !== "/relay/update") return false;
  if (req.method !== "GET" && req.method !== "POST") return false;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET") {
    res.end(JSON.stringify(ctx.relayUpdater.status()));
    return true;
  }

  let version: unknown;
  try {
    version = ((await readJsonBody(req)) as { version?: unknown } | null)?.version;
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "invalid body" }));
    return true;
  }
  if (typeof version !== "string") {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "version is required" }));
    return true;
  }
  const result = ctx.relayUpdater.start(version);
  if (!result.ok) {
    res.writeHead(STATUS_BY_CODE[result.code]);
    res.end(JSON.stringify({ error: result.code, status: result.status }));
    return true;
  }
  res.writeHead(202);
  res.end(JSON.stringify(result.status));
  return true;
};
