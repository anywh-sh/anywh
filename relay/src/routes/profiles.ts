import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isCreateProfileBody, isPatchProfileBody } from "../protocol/guards.js";
import { readJsonBody, readOptionalJsonBody } from "../protocol/httpBody.js";
import { resolveShipped } from "../host/paths.js";
import {
  deleteProfileFiles,
  envFileFor,
  findHomeOverrideCollision,
  isValidProfileId,
  listProfiles,
  slugify,
  updateProfileMeta,
} from "../host/profileRegistry.js";
import { probeRuntimeAuth } from "../runtimes/probes/runtimeAuth.js";
import type { AgentRuntimeDef, AuthStatus } from "../runtimes/types.js";
import type { Registry } from "../runtimes/registry.js";
import type { RouteHandler } from "./context.js";

// Resolved relative to this file (not hardcoded), same reasoning as
// SCRIPTS_DIR in runtimes/executables.ts — works running from `src/` (tsx),
// `dist/` (tsc build, two levels below the repo root) or the macOS SEA
// binary (`infra/` shipped flat next to it) alike.
const ADD_PROFILE_SCRIPT = resolveShipped(import.meta.url, "../../../infra/systemd/add-profile.sh", "infra/systemd/add-profile.sh");

// Same seam as `AGENT_BIN` (runtimes/executables.ts) — defaults to the bare
// command name (works wherever `systemctl --user` is genuinely available),
// overridable so a test never has to shell out to the REAL systemd user
// session, which has no notion of "this is just a test": a real incident
// (2026-09-07) had an integration test's `DELETE /control/profiles/:id`
// call disable+stop the operator's actual live `anywh-relay@trabalho`
// service, SIGKILLing a real in-flight `claude` conversation. `AGENT_BIN`
// already gets this treatment for the same reason; this route's `spawn`
// needed the identical override, not a mock of `spawn` itself.
const SYSTEMCTL_BIN = process.env.SYSTEMCTL_BIN ?? "systemctl";

// What a body that names no runtime means. Every client shipped before the
// runtime became a choice sends exactly that, and every one of them meant
// Claude — this keeps such a client validating against the CLI it always
// validated against, instead of failing on a field it has never heard of.
const DEFAULT_RUNTIME_ID = "claude";

/** Resolves `runtimeId` against the registry, or explains why it couldn't:
 * an id no def answers to is the client's mistake (400), not a login
 * problem, and must never fall back to Claude — silently validating the
 * wrong CLI is the exact bug this route is being cured of. */
function resolveRuntime(registry: Registry, runtimeId: unknown): { def: AgentRuntimeDef; error?: undefined } | { def?: undefined; error: string } {
  const id = typeof runtimeId === "string" && runtimeId.length > 0 ? runtimeId : DEFAULT_RUNTIME_ID;
  const def = registry.get(id);
  return def ? { def } : { error: `unknown runtime "${id}"` };
}

export const handleProfileRoutes: RouteHandler = async (req, res, ctx) => {
  if (req.method === "GET" && req.url?.startsWith("/control/profiles")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    await listProfiles()
      .then((profiles) => res.end(JSON.stringify({ profiles })))
      .catch((error: unknown) => {
        console.error("[relay] failed to list profiles:", error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: "failed to list profiles" }));
      });
    return true;
  }

  if (req.method === "POST" && req.url === "/control/profiles") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    await readJsonBody(req)
      .then(async (body) => {
        if (!isCreateProfileBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "label is required" }));
          return;
        }
        const homeOverride = body.home && body.home.length > 0 ? body.home : undefined;
        const runtime = resolveRuntime(ctx.registry, body.runtimeId);
        if (!runtime.def) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: runtime.error }));
          return;
        }

        // Re-validated here, not trusted from an earlier `/validate` call by
        // the same client: another device could have registered a
        // colliding profile in between, and the client can't have checked
        // login for a `homeOverride` it just typed without a round trip
        // anyway.
        let status: AuthStatus;
        try {
          status = await probeRuntimeAuth(runtime.def, homeOverride);
        } catch (error) {
          console.error(`[relay] ${runtime.def.identity.id} auth check failed:`, error);
          res.writeHead(502);
          res.end(JSON.stringify({ error: `failed to check ${runtime.def.identity.id} auth status` }));
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
    return true;
  }

  if (req.method === "POST" && req.url?.startsWith("/control/profiles/validate")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    await readOptionalJsonBody(req).then(async (body) => {
      const homeOverride = typeof body.homeOverride === "string" && body.homeOverride.length > 0 ? body.homeOverride : undefined;
      const runtime = resolveRuntime(ctx.registry, body.runtimeId);
      if (!runtime.def) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: runtime.error }));
        return;
      }
      let status: AuthStatus;
      try {
        status = await probeRuntimeAuth(runtime.def, homeOverride);
      } catch (error) {
        console.error(`[relay] ${runtime.def.identity.id} auth check failed:`, error);
        res.writeHead(502);
        res.end(JSON.stringify({ error: `failed to check ${runtime.def.identity.id} auth status` }));
        return;
      }
      const collidesWith = findHomeOverrideCollision(homeOverride);
      res.end(JSON.stringify(collidesWith ? { ...status, collidesWith } : status));
    });
    return true;
  }

  if (req.method === "PATCH" && req.url?.startsWith("/control/profiles/")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const id = decodeURIComponent(req.url.slice("/control/profiles/".length).split("?")[0]);
    await readJsonBody(req)
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
    return true;
  }

  if (req.method === "DELETE" && req.url?.startsWith("/control/profiles/")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const id = decodeURIComponent(req.url.slice("/control/profiles/".length).split("?")[0]);
    if (!isValidProfileId(id) || !existsSync(envFileFor(id))) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "profile not found" }));
      return true;
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
    return true;
  }

  return false;
};
