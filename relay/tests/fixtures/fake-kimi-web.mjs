#!/usr/bin/env node
// A fake `kimi web` (Kimi Code CLI 2.6.0's local server), only what the plan
// usage reader touches: `web --no-open --port <p>` binds 127.0.0.1:<p>,
// prints the banner with its bearer token, and serves
// GET /api/v1/oauth/usage and /api/v1/oauth/userinfo in the recorded shapes.
// FAKE_KIMI_WEB_STATE: "ok" (default) or "signed_out". FAKE_KIMI_WEB_LOG gets
// one line per process start and per request. Any request without the
// printed token is refused with 401, like the real server.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.6.0");
  process.exit(0);
}
if (args[0] !== "web") process.exit(2);
const port = Number(args[args.indexOf("--port") + 1]);
const token = "fake-token-0123456789abcdef";
const log = (line) => process.env.FAKE_KIMI_WEB_LOG && appendFileSync(process.env.FAKE_KIMI_WEB_LOG, `${line}\n`);
log(`start ${port}`);

const signedOut = { code: 0, msg: "success", data: { kind: "error", message: 'No token for "kimi-code". Run /login to authenticate.' } };
const bodies = {
  "/api/v1/oauth/usage": {
    code: 0,
    msg: "success",
    data: {
      kind: "ok",
      quota: {
        usages: {
          limit5h: { usedRatio: 0.25, resetAt: "2026-11-13T16:15:38Z" },
          monthTotal: { usedRatio: 0.1235, resetAt: "2026-12-14T00:00:00Z" },
          monthCode: { usedRatio: 0.1235, resetAt: "2026-12-14T00:00:00Z" },
        },
        extraUsage: null,
      },
    },
  },
  "/api/v1/oauth/userinfo": {
    code: 0,
    msg: "success",
    data: { kind: "ok", userInfo: { userId: "user-1", nickname: "someone", email: "a@example.invalid", userLevel: 20, userLevelName: "Plus" } },
  },
};

createServer((req, res) => {
  log(`get ${req.url}`);
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  const body = bodies[req.url];
  if (!body) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(process.env.FAKE_KIMI_WEB_STATE === "signed_out" ? signedOut : body));
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`\n  Kimi server ready  2.6.0\n\n  Local:    http://127.0.0.1:${port}/#token=${token}\n\n  Token:    ${token}\n`);
});
