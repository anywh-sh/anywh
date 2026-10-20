// The room's tools, as data every runtime can declare (an MCP `tools/list`,
// Codex's `dynamicTools`), the validation of their arguments, and the
// standing instructions of each role. Every tool answers at once: delegating
// starts an agent and returns its id, reporting records a report — nothing
// waits for another agent or for a person.
//
// Pure: no I/O.
import type { RoomToolSpec } from "../runtimes/types.js";
import { ROOM_MAX_LIVE_AGENTS, ROOM_REPORT_ARTIFACTS_MAX, ROOM_REPORT_SUMMARY_MAX, ROOM_TASK_MAX, type RoomReportStatus, type RoomRole } from "./room.js";

export const ROOM_MCP_SERVER_NAME = "anywh-room";

export const DELEGATE_TOOL: RoomToolSpec = {
  name: "delegate",
  description:
    "Start a new agent of this room on a task. Returns its agentId at once; it does not wait for the work. The agent " +
    "reports back with a short summary when it finishes, and you are told then — do not poll for it.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Everything the agent needs to do the work on its own: goal, scope, constraints, where to put results." },
      runtime: { type: "string", description: "Which agent CLI runs it: claude or codex." },
      model: { type: "string", description: "Model of that runtime, e.g. haiku, sonnet or opus for claude." },
      effort: { type: "string", description: "Reasoning effort. Leave it out unless the task clearly needs more or less than the model's default." },
      parentId: { type: "string", description: "Agent this one reports to. Defaults to you." },
      area: { type: "string", description: "Named area of the room's canvas to place it in (e.g. Design, Research, Code)." },
    },
    required: ["task", "runtime", "model"],
  },
};

export const MESSAGE_AGENT_TOOL: RoomToolSpec = {
  name: "message_agent",
  description: "Send a message to one of the agents you started (or one below them). It is delivered as that agent's next turn.",
  inputSchema: {
    type: "object",
    properties: {
      agentId: { type: "string" },
      text: { type: "string" },
    },
    required: ["agentId", "text"],
  },
};

export const ROOM_STATUS_TOOL: RoomToolSpec = {
  name: "room_status",
  description: "List the agents of this room: who they report to, what they are doing or how they ended, and their latest report.",
  inputSchema: { type: "object", properties: {} },
};

export const REPORT_TOOL: RoomToolSpec = {
  name: "report",
  description:
    "Report the outcome of your task to whoever started you. Call it once when you finish, fail, or cannot go on without " +
    "help, then end your turn.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["done", "failed", "blocked"], description: "done, failed, or blocked (you need something to continue)." },
      summary: { type: "string", description: `What happened, in at most ${ROOM_REPORT_SUMMARY_MAX} characters. Put long results in a file and list it in artifacts.` },
      artifacts: { type: "array", items: { type: "string" }, description: "Paths of the files (or branches) you produced." },
    },
    required: ["status", "summary"],
  },
};

export function roomToolsFor(role: RoomRole): readonly RoomToolSpec[] {
  return role === "principal" ? [DELEGATE_TOOL, MESSAGE_AGENT_TOOL, ROOM_STATUS_TOOL] : [REPORT_TOOL];
}

/** The room's context as the standing instructions show it: where the
 * folder is and its index (see roomContextIndex.ts). */
export interface RoomContextPrompt {
  readonly dir: string;
  readonly index: string;
}

/** The context goes last in the instructions, after text that is the same for
 * every agent of a role, so agents born together share the longest prefix of
 * their prompt (and the model's cache of it). Nothing that differs per agent
 * may go before it. */
function withContext(instructions: string, context: RoomContextPrompt | undefined, rules: string): string {
  return context ? `${instructions}\n\n${rules}\n\n${context.index.trimEnd()}` : instructions;
}

export function principalInstructions(runtimes: readonly string[], context?: RoomContextPrompt): string {
  return withContext(
    principalBase(runtimes),
    context,
    "The room's shared context is a folder of files, listed in the index below. Tell each agent which of those files matter for its task " +
      "(by name) instead of pasting their content into a task; agents read them on demand. Never edit the index: the relay keeps it.",
  );
}

function principalBase(runtimes: readonly string[]): string {
  return (
    "You are the principal agent of an anywh room: the person talks to you, and you get work done by delegating it to other " +
    "agents. You do not do the work yourself — you can only read files (Read, Grep, Glob) and use the room's tools " +
    `(server ${ROOM_MCP_SERVER_NAME}): delegate starts an agent on a task and returns its agentId at once; message_agent ` +
    "sends a message to an agent you started; room_status lists the room's agents and their reports. Give each agent a " +
    "self-contained task. After delegating, end your turn and tell the person what you started — never wait or poll in a " +
    "loop: each agent reports back with a short summary when it finishes, and you will be told. " +
    `Runtimes you can delegate to: ${runtimes.join(", ")}. At most ${ROOM_MAX_LIVE_AGENTS} agents of a room can be live at once.`
  );
}

export function workerInstructions(context?: RoomContextPrompt): string {
  return withContext(
    workerBase(),
    context,
    `The room's shared context is a folder of files, listed in the index below; read what your task needs, on demand, rather than all of it. ` +
      `Put a long result in that folder as result-<short-name>.md (pick the short name yourself) and list its path in report's artifacts. ` +
      "Never edit INDEX.md: the relay keeps it. Files that arrive after you started are announced to you in a message.",
  );
}

function workerBase(): string {
  return (
    "You are an agent of an anywh room, started by another agent to do one task: the first message you receive. Do the task " +
    `yourself. When you finish — or fail, or cannot go on without help — call report (server ${ROOM_MCP_SERVER_NAME}) once, ` +
    `with status done, failed or blocked, a summary of at most ${ROOM_REPORT_SUMMARY_MAX} characters, and the paths of the ` +
    "files you produced as artifacts; then end your turn. Later messages in this conversation come from whoever started you " +
    "or from the person. Do not rely on background jobs that outlive your turn."
  );
}

// ------------------------------------------------------------ arguments

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(args: Record<string, unknown>, key: string, max: number): Parsed<string | undefined> {
  const value = args[key];
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, error: `${key} must be a string.` };
  if (value.length > max) return { ok: false, error: `${key} is longer than ${max} characters.` };
  return { ok: true, value: value.trim() };
}

function requiredString(args: Record<string, unknown>, key: string, max: number): Parsed<string> {
  const parsed = optionalString(args, key, max);
  if (!parsed.ok) return parsed;
  if (!parsed.value) return { ok: false, error: `${key} is required.` };
  return { ok: true, value: parsed.value };
}

export interface DelegateArgs {
  task: string;
  runtime: string;
  model: string;
  effort?: string;
  parentId?: string;
  area?: string;
}

export function parseDelegateArgs(raw: unknown): Parsed<DelegateArgs> {
  const args = isRecord(raw) ? raw : {};
  const task = requiredString(args, "task", ROOM_TASK_MAX);
  if (!task.ok) return task;
  const runtime = requiredString(args, "runtime", 64);
  if (!runtime.ok) return runtime;
  const model = requiredString(args, "model", 200);
  if (!model.ok) return model;
  const effort = optionalString(args, "effort", 64);
  if (!effort.ok) return effort;
  const parentId = optionalString(args, "parentId", 128);
  if (!parentId.ok) return parentId;
  const area = optionalString(args, "area", 200);
  if (!area.ok) return area;
  return {
    ok: true,
    value: {
      task: task.value,
      runtime: runtime.value.toLowerCase(),
      model: model.value,
      ...(effort.value ? { effort: effort.value } : {}),
      ...(parentId.value ? { parentId: parentId.value } : {}),
      ...(area.value ? { area: area.value } : {}),
    },
  };
}

export interface ReportArgs {
  status: RoomReportStatus;
  summary: string;
  artifacts: string[];
}

export function parseReportArgs(raw: unknown): Parsed<ReportArgs> {
  const args = isRecord(raw) ? raw : {};
  const status = args.status;
  if (status !== "done" && status !== "failed" && status !== "blocked") return { ok: false, error: "status must be done, failed or blocked." };
  if (typeof args.summary !== "string" || args.summary.trim() === "") return { ok: false, error: "summary is required." };
  const summary = args.summary.trim();
  if (summary.length > ROOM_REPORT_SUMMARY_MAX) {
    return { ok: false, error: `summary is ${summary.length} characters; keep it under ${ROOM_REPORT_SUMMARY_MAX} and put the rest in a file listed in artifacts.` };
  }
  const rawArtifacts = args.artifacts ?? [];
  if (!Array.isArray(rawArtifacts) || !rawArtifacts.every((item) => typeof item === "string" && item.length > 0 && item.length <= 1000)) {
    return { ok: false, error: "artifacts must be a list of paths." };
  }
  if (rawArtifacts.length > ROOM_REPORT_ARTIFACTS_MAX) return { ok: false, error: `at most ${ROOM_REPORT_ARTIFACTS_MAX} artifacts.` };
  return { ok: true, value: { status, summary, artifacts: rawArtifacts as string[] } };
}

export interface MessageAgentArgs {
  agentId: string;
  text: string;
}

export function parseMessageAgentArgs(raw: unknown): Parsed<MessageAgentArgs> {
  const args = isRecord(raw) ? raw : {};
  const agentId = requiredString(args, "agentId", 128);
  if (!agentId.ok) return agentId;
  const text = requiredString(args, "text", ROOM_TASK_MAX);
  if (!text.ok) return text;
  return { ok: true, value: { agentId: agentId.value, text: text.value } };
}
