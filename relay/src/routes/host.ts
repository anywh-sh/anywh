import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { isTerminalCloseBody } from "../protocol/guards.js";
import { readJsonBody } from "../protocol/httpBody.js";
import { resolveEditorDescriptor } from "../host/editorHostInfo.js";
import { readGitStatus } from "../host/gitStatus.js";
import { resolveShipped } from "../host/paths.js";
import { killTerminal } from "../host/terminalSession.js";
import type { Capabilities } from "../runtimes/types.js";
import type { RouteHandler } from "./context.js";

export interface SelectableAgentInfo {
  readonly id: string;
  readonly capabilities: Capabilities;
  /** Parsed CLI version (`0.46.0`), for display only — absent when the probe
   * output had nothing version-shaped. */
  readonly version?: string;
}

// Set at boot (server.ts, after runtimes/detection.ts's probe
// resolves) and again on every agent refresh — empty until then, same "older relay/client simply sees
// nothing new" shape as `version` below. Only agents server.ts's own
// SELECTABLE_AGENT_IDS names land here, further filtered to `installed` —
// a relay without the `codex` binary on `$PATH` still only ever offers
// Claude, even though detection probes both.
let selectableAgents: readonly SelectableAgentInfo[] = [];

export function setSelectableAgents(agents: readonly SelectableAgentInfo[]): void {
  selectableAgents = agents;
}

// Same `resolveShipped` reasoning as `runtimes/executables.ts`'s
// `SCRIPTS_DIR`: `package.json` sits beside `src/`, not inside it, in both
// shapes this can run as (dev `src/`, or the tarball/dist layout
// `relay_setup.rs::installed_version()` on the client side already reads
// the very same file from). The macOS SEA binary needs its own flat copy,
// added to `sea-build/build.mjs`'s "ships beside the binary" list for this.
const PACKAGE_JSON_PATH = resolveShipped(import.meta.url, "../../package.json", "package.json");
const RELAY_VERSION = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as { version: string }).version;

/** What this relay can do that an older one cannot, by name: how the client
 * tells "this relay predates the feature, update it" from "the feature is
 * empty" without guessing from version numbers (a relay from a checkout has
 * none). A relay that predates the list sends none, which means "none of
 * them". */
export const RELAY_FEATURES: readonly string[] = ["bots", "self_update"];

/** The features this relay has right now. `self_update` only when it can
 * actually install a release over itself: a Homebrew build, a source
 * checkout or a tree the installer did not lay out has the code but not the
 * ability, and saying otherwise would make the app ask it (and be refused)
 * instead of offering the update that works there. */
export function relayFeatures(canUpdateItself: boolean): readonly string[] {
  return canUpdateItself ? RELAY_FEATURES : RELAY_FEATURES.filter((feature) => feature !== "self_update");
}

export const handleHostRoutes: RouteHandler = async (req, res, ctx) => {
  // Tells the client whether/how it can open a file-panel path in a local
  // editor — see editorHostInfo.ts for why locality is declared via env
  // rather than inferred, and why the peer address is only a downgrade
  // guard on top of that declaration.
  if (req.method === "GET" && req.url === "/host-info") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const editor = resolveEditorDescriptor(process.env, req.socket.remoteAddress);
    // `version` is new — an older relay simply omits it, and the client's
    // type for this field is optional for exactly that reason. Populating
    // it now, ahead of any UI reading it, is what lets that UI eventually
    // warn about drift: every relay already in the field today has none,
    // and it takes an actual round of upgrades before this is useful at all.
    res.end(JSON.stringify({ hostname: hostname(), platform: process.platform, editor, version: RELAY_VERSION, features: relayFeatures(ctx.relayUpdater.status().state !== "unsupported"), agents: selectableAgents }));
    return true;
  }

  // The status bar's left half — the branch and change count of whatever
  // repository the session's cwd happens to sit in. Session-scoped like the
  // `/files/*` routes (the client sends an id, never a path), and
  // deliberately cheap to be wrong about: a cwd outside a repository, a host
  // without git, or a call that times out all answer `{ repo: false }` with
  // a 200, because the segment simply disappears (see gitStatus.ts).
  if (req.method === "GET" && req.url?.startsWith("/git/status")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || ctx.defaultSession;
    const cwd = ctx.sessionStore.getCwdState(sessionId).cwd;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    await readGitStatus(cwd)
      .then((status) => {
        res.end(JSON.stringify(status));
      })
      .catch(() => {
        // `readGitStatus` is documented never to reject; this keeps a broken
        // promise from leaving the request hanging anyway.
        res.end(JSON.stringify({ repo: false }));
      });
    return true;
  }

  // What a running `anywh-bg` job has printed so far — the client asks for
  // it only while a card showing that job is on screen, so nothing polls a
  // log nobody is looking at. Session-scoped like `/git/status`: the client
  // names a job id, never a path; the relay resolves the log file itself.
  if (req.method === "GET" && req.url?.startsWith("/background-jobs/log")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const sessionId = url.searchParams.get("session")?.trim() || ctx.defaultSession;
    const jobId = url.searchParams.get("job")?.trim() ?? "";
    const tail = jobId ? ctx.sessionManager.readBackgroundJobLog(sessionId, jobId) : undefined;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (tail === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "unknown background job" }));
      return true;
    }
    res.end(JSON.stringify({ tail }));
    return true;
  }

  if (req.method === "POST" && req.url?.startsWith("/terminals/close")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    await readJsonBody(req)
      .then((body) => {
        if (!isTerminalCloseBody(body)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "session and term are required" }));
          return;
        }
        killTerminal(ctx.port, body.session, body.term)
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
    return true;
  }

  return false;
};
