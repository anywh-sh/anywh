import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import type { AgentEvent } from "@/lib/relay/relay-types";
import foreground from "./fixtures/subagent-fg.json";
import background from "./fixtures/subagent-bg.json";
import spawnError from "./fixtures/subagent-err.json";

// Same Tauri-API guards as sendMessage.test.tsx — see its comment.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

// The three fixtures are what `claude -p --output-format stream-json` (2.1.289)
// really emitted for an `Agent` call, run through the relay's own mapper — not
// events written by hand. `fg`: a plain call. `bg`: `run_in_background`. `err`:
// `isolation: "worktree"` outside a git repo, which fails before any subagent
// exists. Notably the CLI answers even the plain call with an "Async agent
// launched" acknowledgement; the report only arrives in the `subagent` event.
const FG = foreground as AgentEvent[];
const BG = background as AgentEvent[];
const ERR = spawnError as AgentEvent[];

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay();
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

const T = 1_700_000_000_000;
const TURN_START: AgentEvent = { type: "turn_started", startedAt: T };
const TURN_END: AgentEvent = { type: "turn_ended", stopped: false, durationMs: 5000 };

function send(events: AgentEvent[]): void {
  // Two sockets exist (see pendingChoice.test.tsx); only the mounted tab reacts.
  for (const socket of relay.sockets) for (const event of events) socket.emitMessage({ type: "agent_event", event });
}

function replay(events: AgentEvent[]): void {
  const messages = events.map((event) => ({ type: "agent_event", event }));
  for (const socket of relay.sockets) socket.emitMessage({ type: "history_page", messages, cursor: 0, hasMore: false });
}

async function openConversation(): Promise<void> {
  const user = userEvent.setup();
  renderApp();
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  await screen.findByLabelText(en.chat.composer.placeholder);
}

/** The subagent's own card, at the end of the conversation. */
const agentCards = () => screen.queryAllByText(en.chat.launchedInBackground.agentBadge);
/** The tool-call card for the same call, in the middle of the log — `Agent`
 * is the call's name, shown as the badge. */
const callCards = () => screen.queryAllByText("Agent");

/** Everything up to (and including) the first event satisfying `until`. */
function through(events: AgentEvent[], until: (event: AgentEvent) => boolean): AgentEvent[] {
  return events.slice(0, events.findIndex(until) + 1);
}

/** The same call under another id, so two can run side by side. */
function renamed(events: AgentEvent[], from: string, to: string): AgentEvent[] {
  return JSON.parse(JSON.stringify(events).split(from).join(to)) as AgentEvent[];
}

const startedId = (events: AgentEvent[]): string => (events.find((event) => event.type === "tool_started") as Extract<AgentEvent, { type: "tool_started" }>).toolUseId;

describe("a subagent is drawn once", () => {
  it.each([
    ["a plain call", FG],
    ["a call run in the background", BG],
  ])("while %s runs: only its card at the end of the conversation", async (_name, events) => {
    await openConversation();

    // The call has started, the CLI has not said anything about a subagent yet.
    send([TURN_START, ...through(events, (e) => e.type === "tool_started")]);
    await screen.findByText(en.chat.launchedInBackground.heading);
    expect(agentCards()).toHaveLength(1);
    expect(callCards()).toHaveLength(0);

    // Now the CLI reports it running.
    send(through(events, (e) => e.type === "subagent").slice(2));
    expect(agentCards()).toHaveLength(1);
    expect(callCards()).toHaveLength(0);

    // The call's own result arrives — the "launched" acknowledgement — and the
    // subagent is still running: still one card, and the acknowledgement is not
    // drawn as if it were a result.
    send(through(events, (e) => e.type === "tool_ended"));
    expect(agentCards()).toHaveLength(1);
    expect(callCards()).toHaveLength(0);
    expect(screen.queryByText(/Async agent launched/)).toBeNull();
  });

  it.each([
    ["a plain call", FG, "The agent returned"],
    ["a call run in the background", BG, "The agent completed successfully"],
  ])("once %s is over: nothing is left behind but what the agent said", async (_name, events, reply) => {
    await openConversation();
    send([TURN_START, ...events, TURN_END]);
    expect(await screen.findByText(new RegExp(reply))).toBeInTheDocument();
    expect(agentCards()).toHaveLength(0);
    expect(callCards()).toHaveLength(0);
    expect(screen.queryByText(en.chat.launchedInBackground.heading)).toBeNull();
  });

  it("draws a replayed history the same as the live turn", async () => {
    await openConversation();
    replay([TURN_START, ...FG, TURN_END]);
    expect(await screen.findByText(/The agent returned/)).toBeInTheDocument();
    expect(agentCards()).toHaveLength(0);
    expect(callCards()).toHaveLength(0);
  });

  it("gives each of two parallel subagents one card, and no call card", async () => {
    const other = renamed(FG, startedId(FG), "toolu_other");
    await openConversation();
    send([TURN_START]);
    send(through(FG, (e) => e.type === "subagent"));
    send(through(other, (e) => e.type === "subagent"));
    await screen.findByText(en.chat.launchedInBackground.heading);
    expect(agentCards()).toHaveLength(2);
    expect(callCards()).toHaveLength(0);
  });

  it("leaves nothing behind when the turn is stopped with a subagent running", async () => {
    await openConversation();
    send([TURN_START, ...through(FG, (e) => e.type === "subagent")]);
    await screen.findByText(en.chat.launchedInBackground.heading);
    send([{ type: "turn_ended", stopped: true, durationMs: 1000 }]);
    await vi.waitFor(() => expect(agentCards()).toHaveLength(0));
    expect(callCards()).toHaveLength(0);
  });
});

describe("a task that cannot be told by a subagent card is still drawn", () => {
  it("keeps the error of a call that failed before any subagent existed", async () => {
    const user = userEvent.setup();
    await openConversation();
    send([TURN_START, ...ERR, TURN_END]);

    // No subagent was ever reported, so there is no card — the call is the
    // only place the reason can be read.
    await screen.findByText(/The Agent tool call failed/);
    expect(agentCards()).toHaveLength(0);
    expect(callCards()).toHaveLength(1);

    await user.click(callCards()[0]);
    // The assistant quotes the message too; the card's own body is the `pre`.
    expect(await screen.findByText(/Cannot create agent worktree/, { selector: "pre" })).toBeInTheDocument();
  });

  it("keeps the error when it arrives as replayed history", async () => {
    await openConversation();
    replay([TURN_START, ...ERR, TURN_END]);
    await screen.findByText(/The Agent tool call failed/);
    expect(callCards()).toHaveLength(1);
    expect(agentCards()).toHaveLength(0);
  });

  it("shows no card for the failing call while it is still in flight, and none after", async () => {
    await openConversation();
    send([TURN_START, ...through(ERR, (e) => e.type === "tool_started")]);
    await screen.findByText(en.chat.launchedInBackground.heading);
    expect(callCards()).toHaveLength(0);

    send(ERR.slice(ERR.findIndex((e) => e.type === "tool_ended")));
    await vi.waitFor(() => expect(agentCards()).toHaveLength(0));
    expect(callCards()).toHaveLength(1);
  });

  it("keeps the result of a call the CLI never reported a subagent for", async () => {
    // Synthetic on purpose: no CLI version we ran does this, but the wire does
    // not promise a `subagent` event — without one the call's own result is
    // all there is of the work.
    const user = userEvent.setup();
    await openConversation();
    send([
      TURN_START,
      { type: "tool_started", toolUseId: "legacy", name: "Task", kind: "task", input: { description: "look around" }, subject: { kind: "task", label: "look around" }, startedAt: T },
      { type: "tool_ended", toolUseId: "legacy", content: "THE REPORT", isError: false, endedAt: T + 10 },
      TURN_END,
    ]);
    await vi.waitFor(() => expect(screen.queryAllByText("Task")).toHaveLength(1));
    await user.click(screen.getByText("Task"));
    expect(await screen.findByText("THE REPORT")).toBeInTheDocument();
  });
});
