import { isAbsolute } from "node:path";
import { applyBundle, readBundle } from "../portability/configHome.js";
import { toSnapshot } from "../portability/manifest.js";
import { defaultCwd } from "../host/paths.js";
import { isApplyPortabilityBody } from "../protocol/guards.js";
import { readJsonBody } from "../protocol/httpBody.js";
import type { RouteHandler } from "./context.js";

// The two questions the "bring my configuration" flow asks a relay: what
// does this machine have for runtime X, and take this and write it.
//
// Both accept an explicit `home` on top of this relay's own profile home,
// because the machine that reads a bundle and the machine that applies it
// are usually not the same one — and even locally, creating a second
// profile means writing into a home this relay isn't running under.

function resolveHome(url: URL, fallback: string | undefined): { home: string } | { error: string } {
  const requested = url.searchParams.get("home")?.trim();
  if (!requested) return { home: defaultCwd(fallback) };
  if (!isAbsolute(requested)) return { error: "home must be an absolute path" };
  return { home: requested };
}

export const handlePortabilityRoutes: RouteHandler = async (req, res, ctx) => {
  if (!req.url?.startsWith("/control/portability")) return false;
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET" && url.pathname === "/control/portability") {
    const runtimeId = url.searchParams.get("runtime")?.trim() ?? "";
    const def = ctx.registry.get(runtimeId);
    if (!def) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `unknown runtime "${runtimeId}"` }));
      return true;
    }
    const home = resolveHome(url, ctx.homeOverride);
    if ("error" in home) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: home.error }));
      return true;
    }
    // `full=1` is the same read, contents included — the client asks for
    // the summary to decide whether to offer anything at all, and for the
    // whole thing only once the user says yes.
    const bundle = readBundle(def, home.home);
    res.end(JSON.stringify(url.searchParams.get("full") === "1" ? { ...bundle, found: true } : toSnapshot(bundle)));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/control/portability/apply") {
    await readJsonBody(req)
      .then((body) => {
        if (!isApplyPortabilityBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "bundle with a runtimeId is required" }));
          return;
        }
        const def = ctx.registry.get(body.bundle.runtimeId);
        if (!def) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `unknown runtime "${body.bundle.runtimeId}"` }));
          return;
        }
        const home = resolveHome(url, ctx.homeOverride);
        if ("error" in home) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: home.error }));
          return;
        }
        try {
          const result = applyBundle(def, home.home, body.bundle);
          // Applying a bundle writes hooks, and a hook runs on the next
          // turn. That is nothing the pty on this same relay couldn't
          // already do, but it must never be silent: the response names
          // every path written so the UI can show it.
          console.log(`[relay] applied ${String(result.written.length)} ${body.bundle.runtimeId} config file(s) under ${home.home}`);
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error("[relay] failed to apply portability bundle:", error);
          res.writeHead(500);
          res.end(JSON.stringify({ error: "failed to write configuration" }));
        }
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return true;
  }

  return false;
};
