import { isAbsolute } from "node:path";
import type { WebSocket } from "ws";
import { isAgentLoginCodeMessage } from "../protocol/guards.js";
import { afterAccountChange } from "../routes/accountChange.js";
import { startAgentLogin, type AgentLoginSession } from "../runtimes/login/agentLogin.js";
import { probeRuntimeAuth } from "../runtimes/probes/runtimeAuth.js";
import type { RouteContext } from "../routes/context.js";

/** What `/agent-login` sends. `prompt` carries what the dialog shows;
 * `output` is the CLI's own text, for when no prompt could be read off it.
 * `error.reason` is a fixed vocabulary the client translates; `detail` is
 * the CLI's own words, shown as-is. */
export type AgentLoginServerMessage =
  | { readonly type: "output"; readonly data: string }
  | { readonly type: "prompt"; readonly url: string; readonly userCode?: string; readonly expiresAt?: number; readonly input: "code" | "none" }
  | { readonly type: "invalid-code"; readonly detail: string }
  | { readonly type: "rejected"; readonly detail?: string }
  | { readonly type: "done"; readonly account?: string; readonly plan?: string }
  | { readonly type: "error"; readonly reason: AgentLoginErrorReason; readonly detail?: string };

export type AgentLoginErrorReason = "unknown-runtime" | "unsupported" | "bad-home" | "start-failed" | "failed" | "not-signed-in" | "superseded";

/** One login per runtime and `$HOME`. A second device opening the same
 * login takes over: the first one's process holds a code nobody else can
 * use. */
const active = new Map<string, { readonly login: AgentLoginSession; readonly socket: WebSocket }>();

/**
 * The agent's own account sign-in, run by the relay for the app.
 *
 * The `$HOME` is this relay's own (`ctx.homeOverride`) unless the client
 * names another, absolute one: that is a profile being created, whose own
 * relay doesn't exist yet and whose sign-in is checked before it does (the
 * same reason `/mcp-login` takes a `home`). Only a sign-in under the
 * relay's own home touches this relay's sessions and plan usage. The pasted
 * code goes straight to the CLI's stdin and is never logged. Closing the
 * socket ends the login.
 */
export function handleAgentLoginConnection(socket: WebSocket, url: URL, ctx: RouteContext): void {
  const runtimeId = url.searchParams.get("runtime")?.trim() ?? "";
  const requestedHome = url.searchParams.get("home")?.trim() || undefined;
  const send = (message: AgentLoginServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const fail = (reason: AgentLoginErrorReason, detail?: string): void => {
    send(detail === undefined ? { type: "error", reason } : { type: "error", reason, detail });
    socket.close();
  };

  const def = ctx.registry.get(runtimeId);
  if (!def) return fail("unknown-runtime");
  if (!def.auth.login) return fail("unsupported");
  if (requestedHome !== undefined && !isAbsolute(requestedHome)) return fail("bad-home");
  const home = requestedHome ?? ctx.homeOverride;
  const ownHome = requestedHome === undefined || requestedHome === ctx.homeOverride;
  const key = `${runtimeId}\0${home ?? ""}`;

  const previous = active.get(key);
  if (previous) {
    active.delete(key);
    previous.login.cancel();
    if (previous.socket.readyState === previous.socket.OPEN) {
      previous.socket.send(JSON.stringify({ type: "error", reason: "superseded" } satisfies AgentLoginServerMessage));
      previous.socket.close();
    }
  }

  let login: AgentLoginSession;
  try {
    login = startAgentLogin(def, { homeOverride: home });
  } catch (error) {
    console.error(`[relay] failed to start ${runtimeId} login:`, error);
    return fail("start-failed");
  }
  const entry = { login, socket };
  active.set(key, entry);
  console.log(`[relay] ${runtimeId} login started${ownHome ? "" : " for a new profile's home"}`);

  const release = (): void => {
    if (active.get(key) === entry) active.delete(key);
  };

  login.onEvent((event) => {
    switch (event.type) {
      case "output":
        send({ type: "output", data: event.data });
        return;
      case "prompt": {
        const { url: promptUrl, userCode, expiresInSec } = event.prompt;
        send({
          type: "prompt",
          url: promptUrl,
          ...(userCode !== undefined ? { userCode } : {}),
          ...(expiresInSec !== undefined ? { expiresAt: Date.now() + expiresInSec * 1000 } : {}),
          input: event.input,
        });
        return;
      }
      case "invalid-code":
        send({ type: "invalid-code", detail: event.detail });
        return;
      case "rejected":
        release();
        console.log(`[relay] ${runtimeId} login: code rejected`);
        send(event.detail === undefined ? { type: "rejected" } : { type: "rejected", detail: event.detail });
        socket.close();
        return;
      case "failed":
        release();
        console.log(`[relay] ${runtimeId} login failed`);
        fail("failed", event.detail);
        return;
      case "succeeded":
        release();
        if (ownHome) afterAccountChange(runtimeId, ctx);
        void probeRuntimeAuth(def, home).then(
          (status) => {
            if (!status.loggedIn) return fail("not-signed-in");
            console.log(`[relay] ${runtimeId} login succeeded`);
            send({ type: "done", ...(status.account ? { account: status.account } : {}), ...(status.plan ? { plan: status.plan } : {}) });
            socket.close();
          },
          (error: unknown) => {
            // The CLI said it signed in; a probe that couldn't confirm it
            // is no reason to tell the person it failed.
            console.warn(`[relay] ${runtimeId} auth probe after login failed:`, (error as Error).message);
            send({ type: "done" });
            socket.close();
          },
        );
        return;
    }
  });

  socket.on("message", (raw: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (isAgentLoginCodeMessage(parsed)) login.submitCode(parsed.value);
  });

  socket.on("close", () => {
    if (active.get(key) !== entry) return;
    active.delete(key);
    login.cancel();
  });
}
