import type { ServerResponse } from "node:http";
import { readJsonBody } from "../protocol/httpBody.js";
import type { RouteHandler } from "./context.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(body));
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Bots over HTTP (see session/bot.ts):
 *   GET    /bots                        every bot, as the sidebar lists them
 *   POST   /bots                        creates one: `{ name, soul, mascot?: {
 *                                       character, tone }, templateId?,
 *                                       schedules?: [{ name, cron,
 *                                       prompt, paused? }], agentId?, model?,
 *                                       effort?, permissionMode?, cwd? }` →
 *                                       `201 { bot }` (its room's principal is
 *                                       its conversation: `bot.roomId`)
 *   GET    /bots/:id                    the bot with its tasks and schedules,
 *                                       its soul and its memory
 *   PATCH  /bots/:id                    `{ name?, mascot?, paused?, soul? }`
 *   DELETE /bots/:id                    deletes the bot, its room and its files
 *   PATCH  /bots/:id/memory/:index      `{ text }` rewrites one memory line
 *   DELETE /bots/:id/memory/:index      removes it
 *   POST   /bots/:id/tasks/:n/answer    `{ answer }` to the task's open question
 *   POST   /bots/:id/tasks/:n/cancel    cancels the task
 *   PATCH  /bots/:id/schedules/:sid     `{ paused }`
 *   DELETE /bots/:id/schedules/:sid     removes it
 *   POST   /bots/:id/schedules/:sid/run runs it now
 */
export const handleBotRoutes: RouteHandler = async (req, res, ctx) => {
  const path = req.url?.split("?")[0] ?? "";
  if (path !== "/bots" && !path.startsWith("/bots/")) return false;
  const bots = ctx.botManager;
  const body = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      const value = await readJsonBody(req);
      return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      send(res, 400, { error: "invalid body" });
      return undefined;
    }
  };

  if (path === "/bots") {
    if (req.method === "GET") {
      send(res, 200, { bots: bots.summaries() });
      return true;
    }
    if (req.method === "POST") {
      const input = await body();
      if (!input) return true;
      const created = bots.create(input);
      if (!created.ok) send(res, created.status, { error: created.error });
      else send(res, 201, { bot: created.value });
      return true;
    }
    send(res, 405, { error: "method not allowed" });
    return true;
  }

  const segments = path.slice("/bots/".length).split("/").map(decode);
  if (segments.some((segment) => segment === undefined || segment === "")) {
    send(res, 404, { error: "not found" });
    return true;
  }
  const [id, kind, key, action] = segments as string[];
  const bot = bots.get(id);
  if (!bot) {
    send(res, 404, { error: "bot not found" });
    return true;
  }

  if (kind === undefined) {
    if (req.method === "GET") {
      send(res, 200, { bot: bots.view(bot.roomId), soul: bots.soulOf(id), memory: bots.memoryOf(id) });
      return true;
    }
    if (req.method === "PATCH") {
      const input = await body();
      if (!input) return true;
      const patched = bots.patch(id, input);
      if (!patched.ok) send(res, patched.status, { error: patched.error });
      else send(res, 200, { bot: patched.value });
      return true;
    }
    if (req.method === "DELETE") {
      bots.remove(id);
      send(res, 200, { ok: true });
      return true;
    }
  }

  if (kind === "memory" && key !== undefined && action === undefined) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) {
      send(res, 404, { error: "no such memory line" });
      return true;
    }
    if (req.method === "DELETE" || req.method === "PATCH") {
      let text: string | null = null;
      if (req.method === "PATCH") {
        const input = await body();
        if (!input) return true;
        if (typeof input.text !== "string" || input.text.trim() === "" || input.text.length > 500) {
          send(res, 400, { error: "text must be a non-empty string of at most 500 characters" });
          return true;
        }
        text = input.text;
      }
      if (!bots.editMemory(id, index, text)) send(res, 404, { error: "no such memory line" });
      else send(res, 200, { memory: bots.memoryOf(id) });
      return true;
    }
  }

  if (kind === "tasks" && key !== undefined && req.method === "POST" && (action === "answer" || action === "cancel")) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1) {
      send(res, 404, { error: "task not found" });
      return true;
    }
    let result;
    if (action === "answer") {
      const input = await body();
      if (!input) return true;
      result = bots.answerTask(id, n, input.answer);
    } else {
      result = bots.cancelTask(id, n);
    }
    if (!result.ok) send(res, result.status, { error: result.error });
    else send(res, 200, { ok: true });
    return true;
  }

  if (kind === "schedules" && key !== undefined) {
    let result;
    if (action === undefined && req.method === "PATCH") {
      const input = await body();
      if (!input) return true;
      result = bots.updateSchedule(id, key, input);
    } else if (action === undefined && req.method === "DELETE") {
      result = bots.removeSchedule(id, key);
    } else if (action === "run" && req.method === "POST") {
      result = bots.runScheduleNow(id, key);
    }
    if (result) {
      if (!result.ok) send(res, result.status, { error: result.error });
      else send(res, 200, { ok: true });
      return true;
    }
  }

  send(res, 404, { error: "not found" });
  return true;
};
