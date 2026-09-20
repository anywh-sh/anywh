import { isAbsolute } from "node:path";
import type { WebSocket } from "ws";
import { startMcpLogin } from "../portability/mcpAuth.js";
import { defaultCwd } from "../host/paths.js";
import { isTerminalInputMessage } from "../protocol/guards.js";
import type { RouteContext } from "../routes/context.js";

/**
 * One MCP sign-in per connection — the CLI's own `mcp login`, streamed.
 *
 * Same tiny protocol as `/terminal` (`data`/`exit` out, `input` in) and for
 * the same reason: what the user is looking at *is* a CLI's output, and
 * what they send back is a line typed into it. The difference is lifetime
 * — this one is a single command that ends, so closing the socket kills it
 * rather than detaching. A half-finished OAuth flow left running would sit
 * there holding a callback listener nobody is going to reach.
 *
 * Nothing here parses the traffic. The authorization URL goes out as text
 * and the redirect URL comes back as text; the token it becomes is written
 * by the CLI, into its own store, and this relay never sees it.
 */
export function handleMcpLoginConnection(socket: WebSocket, url: URL, ctx: RouteContext): void {
  const runtimeId = url.searchParams.get("runtime")?.trim() ?? "";
  const serverName = url.searchParams.get("server")?.trim() ?? "";
  const requestedHome = url.searchParams.get("home")?.trim();

  const fail = (error: string): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "error", error }));
    socket.close();
  };

  const def = ctx.registry.get(runtimeId);
  if (!def) return fail(`unknown runtime "${runtimeId}"`);
  if (serverName.length === 0) return fail("server is required");
  if (requestedHome && !isAbsolute(requestedHome)) return fail("home must be an absolute path");
  if (def.portability.mcp.kind !== "supported") return fail(`runtime "${runtimeId}" declares no MCP support`);

  const home = requestedHome ?? defaultCwd(ctx.homeOverride);
  let login;
  try {
    login = startMcpLogin(def, home, serverName);
  } catch (error) {
    console.error("[relay] failed to start mcp login:", error);
    return fail("failed to start the login");
  }
  console.log(`[relay] mcp login started for ${runtimeId}/${serverName} under ${home}`);

  login.onData((chunk) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "data", data: chunk }));
  });
  login.onExit((code) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "exit", code }));
    socket.close();
  });

  socket.on("message", (raw: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Reuses the terminal's own input guard: identical shape, and a second
    // guard for the same three fields would be two places to keep right.
    if (isTerminalInputMessage(parsed)) login.write(parsed.data);
  });

  socket.on("close", () => {
    login.kill();
  });
}
