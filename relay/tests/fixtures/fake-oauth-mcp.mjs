// A local OAuth authorization server and the MCP server it protects, for the
// conformance tier only (tests/conformance/): what the REAL agent CLIs sign in to and call, so the
// undocumented sign-in and tool-call requests the relay relies on are checked
// against the installed CLI versions without any real provider. Loopback
// only, every secret random per run.
//
// - Protected-resource and authorization-server metadata, dynamic client
//   registration (`rejectCustomRedirect` refuses any redirect that is not
//   loopback http, as strict providers do), `/authorize` that consents at
//   once with a 302 to the client's redirect (the test plays the browser:
//   it reads `Location` without following it), `/token` with a configurable
//   lifetime, refresh-token rotation and a refresh that can be made to fail.
// - `/mcp`: streamable HTTP (JSON answers), 401 with `WWW-Authenticate`
//   without a valid token; one read-only tool, `ping` → `pong`.
// - `admin({revoke, refreshFails, ttl, rotate})` changes it mid-run.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const token = () => randomBytes(16).toString("hex");
const isLoopbackHttp = (uri) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri);

export function startFakeOAuthMcp(options = {}) {
  const codes = new Map();
  const access = new Map();
  const refresh = new Set();
  const registrations = [];
  const calls = [];
  let refreshFails = false;
  let ttlSecs = options.accessTtlSecs ?? 3600;
  let rotate = true;
  let base = "";
  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read"] });
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["read"],
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const request = JSON.parse(body || "{}");
        const uris = request.redirect_uris ?? [];
        registrations.push(uris);
        if (options.rejectCustomRedirect && uris.some((uri) => !isLoopbackHttp(uri))) return json(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uri must be loopback http" });
        return json(res, 201, { ...request, client_id: `client-${token().slice(0, 8)}`, token_endpoint_auth_method: "none" });
      }
      if (url.pathname === "/authorize") {
        const code = token();
        codes.set(code, url.searchParams.get("redirect_uri"));
        const location = new URL(url.searchParams.get("redirect_uri") ?? "");
        location.searchParams.set("code", code);
        location.searchParams.set("state", url.searchParams.get("state") ?? "");
        res.writeHead(302, { location: location.toString() });
        return res.end();
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(body);
        const grant = form.get("grant_type");
        if (grant === "authorization_code" && !codes.delete(form.get("code") ?? "")) return json(res, 400, { error: "invalid_grant" });
        if (grant === "refresh_token") {
          const presented = form.get("refresh_token") ?? "";
          if (refreshFails || !refresh.has(presented)) return json(res, 400, { error: "invalid_grant" });
          if (rotate) refresh.delete(presented);
        }
        const accessToken = token();
        const refreshToken = token();
        access.set(accessToken, Date.now() + ttlSecs * 1000);
        refresh.add(refreshToken);
        return json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: ttlSecs, refresh_token: refreshToken, scope: "read" });
      }
      if (url.pathname === "/mcp") {
        const presented = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        const expires = access.get(presented);
        if (!expires || expires < Date.now()) {
          res.writeHead(401, { "www-authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource"` });
          return res.end();
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          return res.end();
        }
        const message = JSON.parse(body);
        if (message.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        if (message.method === "tools/call") calls.push(message.params?.name);
        const result =
          message.method === "initialize"
            ? { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-oauth-mcp", version: "0.0.1" } }
            : message.method === "tools/list"
              ? { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] }
              : message.method === "tools/call"
                ? { content: [{ type: "text", text: "pong" }] }
                : {};
        return json(res, 200, { jsonrpc: "2.0", id: message.id, result }, { "mcp-session-id": "s1" });
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: `${base}/mcp`,
        base,
        registrations,
        calls,
        admin({ revoke, fails, ttl, rotating } = {}) {
          if (revoke) access.clear();
          if (fails !== undefined) refreshFails = fails;
          if (ttl !== undefined) ttlSecs = ttl;
          if (rotating !== undefined) rotate = rotating;
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Plays the browser: opens the authorization URL and returns where the
 * server sends it back, without following it (an `anywh://` link or a
 * loopback callback). */
export async function consent(authUrl) {
  const response = await fetch(authUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) throw new Error(`no redirect from the authorization endpoint (${response.status})`);
  return location;
}
