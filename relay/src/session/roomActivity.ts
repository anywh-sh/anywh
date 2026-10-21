// What each agent of a room has just been doing, as a short trail of actions
// (a tool call, a bout of reasoning) for the agent's card. Fed by the same
// events the conversation's "Working" block is built from, so a card and its
// conversation say the same things. Pure and in memory: a trail is a glimpse
// of the present, not a record, and a restart starts it again.
import type { AgentEvent, ToolSubject } from "../protocol/agent-event.js";
import { isConnectorServer } from "./room.js";

/** What kind of thing an action was: the client's verb for a tool call, or
 * `think` for reasoning. */
export type RoomActionVerb = "think" | "read" | "edit" | "write" | "shell" | "searchFiles" | "searchContent" | "webSearch" | "webFetch" | "mcp" | "task" | "other";

export interface RoomAction {
  id: string;
  verb: RoomActionVerb;
  /** What it acted on, short enough for a card line: a file's name, the
   * command's first line, the query, `server.tool`. */
  target?: string;
  /** Epoch ms. */
  startedAt: number;
  /** Absent while it is going on. */
  endedAt?: number;
  /** The tool call failed. */
  failed?: true;
}

/** Actions kept per agent: what a card has room for. */
export const ROOM_ACTIONS_KEPT = 3;
const TARGET_MAX = 60;

function cut(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > TARGET_MAX ? `${line.slice(0, TARGET_MAX - 1).trimEnd()}…` : line;
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter((part) => part !== "").pop() ?? path;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The verb and target of a call, the same way the conversation's activity
 * names them. */
export function describeCall(name: string, kind: string, subject: ToolSubject | undefined): Pick<RoomAction, "verb" | "target"> {
  if (!subject) {
    const verb: RoomActionVerb = kind === "search" ? "searchContent" : kind === "web" ? "webSearch" : (["read", "edit", "write", "shell", "mcp", "task"] as const).find((v) => v === kind) ?? "other";
    return { verb, target: cut(name) };
  }
  switch (subject.kind) {
    case "read":
    case "edit":
    case "write":
      return { verb: subject.kind, target: basename(subject.path) };
    case "shell":
      return { verb: "shell", target: cut(subject.command) };
    case "search":
      return { verb: subject.mode === "files" ? "searchFiles" : "searchContent", target: cut(subject.pattern) };
    case "web":
      return subject.mode === "search" ? { verb: "webSearch", target: cut(subject.query) } : { verb: "webFetch", target: hostOf(subject.url) };
    case "mcp":
      return { verb: "mcp", target: cut(`${subject.server}.${subject.tool}`) };
    case "task":
      return { verb: "task", target: cut(subject.label) };
    case "other":
      return { verb: "other", target: cut(subject.label) };
  }
}

export class ActivityTrail {
  private readonly trails = new Map<string, RoomAction[]>();
  private counter = 0;

  /** Notes an event of `agentId`'s turn. `true` when the trail changed. A
   * subagent's events, the relay's own bridge calls and the answer's text
   * are not actions of the agent. */
  observe(agentId: string, event: AgentEvent, now = Date.now()): boolean {
    const trail = this.trails.get(agentId) ?? [];
    const push = (action: RoomAction): void => {
      trail.push(action);
      while (trail.length > ROOM_ACTIONS_KEPT) trail.shift();
      this.trails.set(agentId, trail);
    };
    switch (event.type) {
      case "thinking_started":
        push({ id: `think-${String((this.counter += 1))}`, verb: "think", startedAt: event.startedAt ?? now });
        return true;
      case "thinking": {
        if (event.parentToolUseId !== undefined) return false;
        const open = trail[trail.length - 1];
        if (open?.verb === "think" && open.endedAt === undefined) {
          open.endedAt = event.endedAt ?? now;
          return true;
        }
        push({ id: `think-${String((this.counter += 1))}`, verb: "think", startedAt: event.startedAt ?? now, endedAt: event.endedAt ?? now });
        return true;
      }
      case "tool_started": {
        if (event.parentToolUseId !== undefined) return false;
        if (event.subject?.kind === "mcp" && !isConnectorServer(event.subject.server)) return false;
        push({ id: event.toolUseId ?? `call-${String((this.counter += 1))}`, ...describeCall(event.name, event.kind, event.subject), startedAt: event.startedAt ?? now });
        return true;
      }
      case "tool_ended": {
        if (event.parentToolUseId !== undefined || event.toolUseId === undefined) return false;
        const action = trail.find((a) => a.id === event.toolUseId);
        if (!action) return false;
        action.endedAt = event.endedAt ?? now;
        if (event.isError) action.failed = true;
        return true;
      }
      case "turn_ended": {
        // Nothing is going on after a turn, whatever never reported its end.
        let changed = false;
        for (const action of trail) {
          if (action.endedAt === undefined) {
            action.endedAt = now;
            changed = true;
          }
        }
        return changed;
      }
      case "plan":
      case "status":
      case "error":
      case "turn_started":
      case "user_message":
      case "text_delta":
      case "text":
      case "thinking_delta":
      case "tool_input_delta":
      case "tool_progress":
      case "subagent":
      case "session_id":
      case "usage":
      case "compact_boundary":
      case "context_attribution":
        return false;
    }
  }

  /** Oldest first. */
  recent(agentId: string): RoomAction[] {
    return (this.trails.get(agentId) ?? []).map((action) => ({ ...action }));
  }

  forget(agentId: string): void {
    this.trails.delete(agentId);
  }
}
