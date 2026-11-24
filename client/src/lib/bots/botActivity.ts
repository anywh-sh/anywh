import type { ToolCallEntry } from "@/hooks/relay/useMessageLog";

/** What a bot did with one of its own tools, as a line of its conversation:
 * the task list, its memory, its schedules — the things the person follows
 * outside the chat, and the other bots it reached. `n` is the task's number,
 * `name` the other bot as the call named it, `text` what the line names. */
export type BotActivity =
  | { kind: "created" | "updated" | "asked"; n: number; text?: string }
  | { kind: "delegated"; n?: number; text?: string }
  | { kind: "askedBot" | "handedOff"; name: string; text?: string }
  | { kind: "remembered" | "forgot" | "soul" | "scheduled" | "scheduleChanged" | "scheduleRemoved" | "status" | "peers"; text?: string };

const ROOM_SERVER = "anywh-room";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value.replace(/^#/, "")) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * A finished, successful call of a bot's own tool, read as a line; anything
 * else (a failed call, a running one, any other tool, a room's `delegate`
 * without a task) stays where the log normally draws it. Only bots have these
 * tools, so an ordinary room's conversation never changes.
 */
export function botActivityOf(call: ToolCallEntry): BotActivity | undefined {
  if (!call.done || call.isError || call.subject?.kind !== "mcp" || call.subject.server !== ROOM_SERVER) return undefined;
  const input = (typeof call.input === "object" && call.input !== null ? call.input : {}) as Record<string, unknown>;
  switch (call.subject.tool) {
    case "task_create": {
      let n: number | undefined;
      try {
        n = num((JSON.parse(call.content ?? "{}") as { task?: unknown }).task);
      } catch {
        n = undefined;
      }
      return n === undefined ? undefined : { kind: "created", n, ...(str(input.title) ? { text: str(input.title) } : {}) };
    }
    case "task_update": {
      const n = num(input.task);
      return n === undefined ? undefined : { kind: "updated", n, ...(str(input.note) ?? str(input.title) ? { text: str(input.note) ?? str(input.title) } : {}) };
    }
    case "task_ask": {
      const n = num(input.task);
      return n === undefined ? undefined : { kind: "asked", n, ...(str(input.question) ? { text: str(input.question) } : {}) };
    }
    case "delegate": {
      const n = num(input.task_number);
      if (n === undefined) return undefined;
      return { kind: "delegated", n, ...(str(input.name) ? { text: str(input.name) } : {}) };
    }
    case "remember":
      return { kind: "remembered", ...(str(input.text) ? { text: str(input.text) } : {}) };
    case "forget":
      return { kind: "forgot", ...(str(input.text) ? { text: str(input.text) } : {}) };
    case "set_soul":
      return { kind: "soul" };
    case "schedule_create":
      return { kind: "scheduled", ...(str(input.name) ? { text: str(input.name) } : {}) };
    case "schedule_update":
      return { kind: "scheduleChanged" };
    case "schedule_remove":
      return { kind: "scheduleRemoved" };
    case "bot_status":
      return { kind: "status" };
    case "bot_list":
      return { kind: "peers" };
    case "bot_ask": {
      const name = str(input.to);
      return name === undefined ? undefined : { kind: "askedBot", name, ...(str(input.question) ? { text: str(input.question) } : {}) };
    }
    case "bot_handoff": {
      const name = str(input.to);
      return name === undefined ? undefined : { kind: "handedOff", name, ...(str(input.title) ? { text: str(input.title) } : {}) };
    }
    default:
      return undefined;
  }
}
