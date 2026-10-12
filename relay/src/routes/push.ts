import { isValidDeviceId, parsePushDeviceBody } from "../push/pushDevices.js";
import { readJsonBody } from "../protocol/httpBody.js";
import type { RouteHandler } from "./context.js";

const PREFIX = "/push/devices";

/** The push-address registry's HTTP surface (docs/push.md, contract B). No
 * auth of its own, like every other route on this server — the network the
 * relay is reachable on is the boundary. With push disabled
 * (`RELAY_PUSH_DISABLED=1`) none of this exists and a client sees the same
 * answer an older relay gives, which is what makes it keep notifying
 * locally. */
export const handlePushRoutes: RouteHandler = async (req, res, ctx) => {
  const store = ctx.pushStore;
  const path = req.url?.split("?")[0];
  if (!store || !path || (path !== PREFIX && !path.startsWith(`${PREFIX}/`))) return false;

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (path === PREFIX) {
    if (req.method !== "GET") return false;
    res.end(JSON.stringify({ devices: store.list() }));
    return true;
  }

  let deviceId: string;
  try {
    deviceId = decodeURIComponent(path.slice(PREFIX.length + 1));
  } catch {
    deviceId = "";
  }
  if (!isValidDeviceId(deviceId)) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "invalid device id" }));
    return true;
  }

  if (req.method === "PUT") {
    await readJsonBody(req)
      .then((body) => {
        const parsed = parsePushDeviceBody(body);
        if (!parsed.ok) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid push device" }));
          return;
        }
        store.put(deviceId, parsed.value);
        res.writeHead(204);
        res.end();
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return true;
  }

  if (req.method === "DELETE") {
    // Idempotent: asking to forget something already gone is success, so a
    // client logging out never has to care which relays still had it.
    store.delete(deviceId);
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
};
