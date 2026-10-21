// The room's tools, as data every runtime can declare (an MCP `tools/list`,
// Codex's `dynamicTools`), the validation of their arguments, and the
// standing instructions of each role. Every tool answers at once: delegating
// starts an agent and returns its id, reporting records a report — nothing
// waits for another agent or for a person.
//
// Pure: no I/O.
import type { RoomToolSpec } from "../runtimes/types.js";
import { ROOM_AGENT_NAME_MAX, ROOM_AGENT_PURPOSE_MAX, ROOM_MAX_LIVE_AGENTS, ROOM_REPORT_ARTIFACTS_MAX, ROOM_REPORT_SUMMARY_MAX, ROOM_TASK_MAX, type RoomReportStatus, type RoomRole } from "./room.js";

export const ROOM_MCP_SERVER_NAME = "anywh-room";

export const DELEGATE_TOOL: RoomToolSpec = {
  name: "delegate",
  description:
    "Start a new agent of this room on a task. Returns at once; it does not wait for the work. The agent reports back with " +
    "a short summary when it finishes, and you are told then — do not poll for it. To give more work to an agent that " +
    "already exists, use message_agent instead.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: `The agent's name: its role in two or three words, in the person's language (e.g. "Slack", "Pricing research"). Unique in the room; at most ${ROOM_AGENT_NAME_MAX} characters.` },
      purpose: { type: "string", description: "One line on what the agent is for (e.g. \"reads and summarizes Slack channels\"), so you can tell later whether new work fits it." },
      task: { type: "string", description: "Everything the agent needs to do the work on its own: goal, scope, constraints, where to put results." },
      runtime: { type: "string", description: "Which agent CLI runs it: claude or codex." },
      model: { type: "string", description: "Model of that runtime, e.g. haiku, sonnet or opus for claude." },
      effort: { type: "string", description: "Reasoning effort. Leave it out unless the task clearly needs more or less than the model's default." },
      parentId: { type: "string", description: "Name (or agentId) of the agent this one reports to. Defaults to you." },
      area: {
        type: "string",
        description:
          "Optional area of the room's canvas for agents whose work adds up to one result: an existing one, by its name as " +
          "room_status lists it, or a new one named for that result. Leave it out for an agent that works alone.",
      },
    },
    required: ["name", "purpose", "task", "runtime", "model"],
  },
};

export const MESSAGE_AGENT_TOOL: RoomToolSpec = {
  name: "message_agent",
  description:
    "Send a message to one of the agents you started (or one below them), including one that already reported: it keeps " +
    "its whole conversation, so this is how you give it a follow-up or a new task in its role. Delivered as its next turn, " +
    "after the one it is running: to change its course now, stop_agent it first.",
  inputSchema: {
    type: "object",
    properties: {
      agent: { type: "string", description: "The agent's name (or its agentId)." },
      text: { type: "string" },
    },
    required: ["agent", "text"],
  },
};

export const STOP_AGENT_TOOL: RoomToolSpec = {
  name: "stop_agent",
  description:
    "Stop one of the agents you started (or one below them) now, as the person's Stop does: its running turn ends and the " +
    "messages queued for it are dropped. It keeps its conversation; message_agent gives it new work and wakes it.",
  inputSchema: {
    type: "object",
    properties: { agent: { type: "string", description: "The agent's name (or its agentId)." } },
    required: ["agent"],
  },
};

export const ROOM_STATUS_TOOL: RoomToolSpec = {
  name: "room_status",
  description:
    "List the agents of this room (name, purpose, area, who they report to, what they are doing or how they ended, latest " +
    "report) and its areas, the ones the person made included.",
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
      integrated: { type: "boolean", description: "True when the work of your worktree branch was already merged into its base (a squash or rebase merge included), so the relay may clean the worktree up." },
    },
    required: ["status", "summary"],
  },
};

/** What the CLI asks of its `--permission-prompt-tool` when a worker's tool
 * call needs approval. Served on the room's bridge beside the room tools but
 * not one of them: the model never calls it, the CLI does, so it is not part
 * of the instructions, the allowed tools or Codex's dynamic tools. */
export const APPROVE_TOOL: RoomToolSpec = {
  name: "approve",
  description: "Decides whether a pending tool call may run. Called by the CLI itself for every action that needs approval, never by the model.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
      agent_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

export const WORKTREE_CREATE_TOOL: RoomToolSpec = {
  name: "worktree_create",
  description:
    "Create your own git worktree of a repository, on a new branch, so your changes do not collide with other agents' or the " +
    "person's. Call it once per repository before you modify files in it, then work only inside the returned workdir. " +
    "Commit your work there; the worktree is removed by the relay once its branch is merged.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "The repository: an absolute path, or one relative to your working folder. A folder inside it works too." },
    },
    required: ["repo"],
  },
};

export function roomToolsFor(role: RoomRole): readonly RoomToolSpec[] {
  return role === "principal" ? [DELEGATE_TOOL, MESSAGE_AGENT_TOOL, STOP_AGENT_TOOL, ROOM_STATUS_TOOL] : [REPORT_TOOL, WORKTREE_CREATE_TOOL];
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
    "You are the principal agent of an anywh room. The person talks to you; the room's agents do the work. You never do it " +
    "yourself: you can read files (Read, Grep, Glob) and use the room's tools " +
    `(server ${ROOM_MCP_SERVER_NAME}) — delegate starts an agent, message_agent gives more work to one that exists, ` +
    "stop_agent ends an agent's current turn, room_status shows the agents and areas.\n\n" +
    "How you run the room:\n" +
    "- Plan first. Find the pieces of work a request really contains and what each depends on. Pieces that can run " +
    "independently go to separate agents, started together in the same turn. A piece that needs another's result starts " +
    "once that agent has reported, as its own agent. Don't split work too small to be worth an agent, and never let two " +
    "agents change the same files.\n" +
    "- Reuse before you add. Agents keep their conversation after reporting or being stopped; when an existing agent's " +
    "purpose fits the new work, give it the work with message_agent. A message wakes a stopped agent, so leave one the " +
    "person stopped alone unless they ask for it.\n" +
    "- Each new agent gets a short role name in the person's language and a one-line purpose. Talk about agents by name, " +
    "never by id.\n" +
    "- Areas are an optional visual aid for the person. An area holds agents whose work adds up to one result; agents " +
    "working toward different results stay apart, even on the same subject or with the same kind of work. Decide by the " +
    "plan, not the turn: agents that will work toward one result, now or in a later stage, share an area from the first one " +
    "on. Name an area for its result, put a new agent in an existing area only if it serves that same result, and leave an " +
    "agent that works alone outside any area.\n" +
    "- Delegate self-contained tasks, tell the person the plan, and end your turn. Reports arrive on their own; never wait " +
    "or poll.\n\n" +
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
    "files you produced as artifacts; then end your turn. Whoever started you does not read your replies, only your report, " +
    "so never end a turn of work without it. Later messages in this conversation come from whoever started you " +
    "or from the person, and may give you more work in your role: report again, the same way, when you finish each. Do not rely on background jobs that outlive your turn. If your task changes files in a git repository, " +
    "call worktree_create with that repository first and make every change, and commit, inside the workdir it returns; " +
    "mention the branch in your report. Never remove a worktree or its branch yourself."
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
  /** Absent from an agent whose tool list predates names (a Codex thread
   * keeps the tools it was started with) and from the person's launcher. */
  name?: string;
  purpose?: string;
  task: string;
  runtime: string;
  model: string;
  effort?: string;
  parentId?: string;
  area?: string;
}

export function parseDelegateArgs(raw: unknown): Parsed<DelegateArgs> {
  const args = isRecord(raw) ? raw : {};
  const name = optionalString(args, "name", ROOM_AGENT_NAME_MAX);
  if (!name.ok) return name;
  const purpose = optionalString(args, "purpose", ROOM_AGENT_PURPOSE_MAX);
  if (!purpose.ok) return purpose;
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
      ...(name.value ? { name: name.value } : {}),
      ...(purpose.value ? { purpose: purpose.value } : {}),
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
  integrated?: boolean;
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
  if (args.integrated !== undefined && typeof args.integrated !== "boolean") return { ok: false, error: "integrated must be true or false." };
  return { ok: true, value: { status, summary, artifacts: rawArtifacts as string[], ...(args.integrated === true ? { integrated: true } : {}) } };
}

export interface MessageAgentArgs {
  /** The agent's name or id, as the caller wrote it. */
  agent: string;
  text: string;
}

export function parseMessageAgentArgs(raw: unknown): Parsed<MessageAgentArgs> {
  const args = isRecord(raw) ? raw : {};
  // `agentId` is what the tool took before names: a Codex thread keeps the
  // tool list it was started with.
  const agent = requiredString(args.agent === undefined ? { agent: args.agentId } : args, "agent", 200);
  if (!agent.ok) return agent;
  const text = requiredString(args, "text", ROOM_TASK_MAX);
  if (!text.ok) return text;
  return { ok: true, value: { agent: agent.value, text: text.value } };
}

export function parseStopAgentArgs(raw: unknown): Parsed<{ agent: string }> {
  const args = isRecord(raw) ? raw : {};
  const agent = requiredString(args.agent === undefined ? { agent: args.agentId } : args, "agent", 200);
  return agent.ok ? { ok: true, value: { agent: agent.value } } : agent;
}

export function parseWorktreeCreateArgs(raw: unknown): Parsed<{ repo: string }> {
  const repo = requiredString(isRecord(raw) ? raw : {}, "repo", 4096);
  return repo.ok ? { ok: true, value: { repo: repo.value } } : repo;
}
