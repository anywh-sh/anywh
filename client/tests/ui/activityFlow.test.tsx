import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import type { AgentEvent } from "@/lib/relay/relay-types";

// Same Tauri-API guards as sendMessage.test.tsx — see its comment.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

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

/** One scripted turn as the relay would deliver it: text, a parallel batch
 * of two calls, reasoning, a failing command and its retry, then the reply. */
const TURN: AgentEvent[] = [
  { type: "turn_started", startedAt: T },
  { type: "text", text: "Let me look at the socket first." },
  { type: "tool_started", toolUseId: "r1", name: "Read", kind: "read", input: {}, subject: { kind: "read", path: "/w/src/socket.ts" }, startedAt: T + 1000, batchId: "m1" },
  { type: "tool_started", toolUseId: "g1", name: "Grep", kind: "search", input: {}, subject: { kind: "search", mode: "content", pattern: "onclose" }, startedAt: T + 1000, batchId: "m1" },
  { type: "tool_ended", toolUseId: "r1", content: "one\ntwo", isError: false, outcome: { kind: "code", path: "/w/src/socket.ts", lines: ["one", "two"], startLine: 1 }, endedAt: T + 1500 },
  { type: "tool_ended", toolUseId: "g1", content: "a.ts:2:x", isError: false, outcome: { kind: "matches", matches: [{ path: "a.ts", line: 2, text: "x" }] }, endedAt: T + 3000 },
  { type: "thinking", thinking: "", startedAt: T + 3000, endedAt: T + 6000 },
  { type: "tool_started", toolUseId: "b1", name: "Bash", kind: "shell", input: {}, subject: { kind: "shell", command: "npm test" }, startedAt: T + 6000 },
  { type: "tool_ended", toolUseId: "b1", content: "Exit code 1", isError: true, outcome: { kind: "terminal", output: "1 failing", exitCode: 1 }, endedAt: T + 8000 },
  { type: "tool_started", toolUseId: "b2", name: "Bash", kind: "shell", input: {}, subject: { kind: "shell", command: "npm test" }, startedAt: T + 8000 },
  { type: "tool_ended", toolUseId: "b2", content: "ok", isError: false, outcome: { kind: "terminal", output: "8 passing", exitCode: 0 }, endedAt: T + 11000 },
  { type: "text", text: "All green now." },
  { type: "turn_ended", stopped: false, durationMs: 12_000 },
];

function broadcast(messages: unknown[]): void {
  // Two sockets exist (see pendingChoice.test.tsx); only the mounted tab reacts.
  for (const socket of relay.sockets) for (const message of messages) socket.emitMessage(message);
}

async function openConversation(): Promise<void> {
  const user = userEvent.setup();
  renderApp();
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  await screen.findByLabelText(en.chat.composer.placeholder);
}

async function expectFlow(): Promise<void> {
  const user = userEvent.setup();
  // The first group: the parallel read + search, in the past tense, with the
  // parallel suffix; and the second, the failing command and its retry.
  expect(await screen.findByText(/Read socket\.ts, searched onclose/)).toBeInTheDocument();
  expect(screen.getByText(/2 in parallel/)).toBeInTheDocument();
  expect(screen.getByText(/Ran npm test 2×/)).toBeInTheDocument();
  expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  expect(screen.getByText("Thought for 3s")).toBeInTheDocument();
  expect(screen.getByText("All green now.")).toBeInTheDocument();
  expect(screen.getByText(/worked 12s/)).toBeInTheDocument();

  // Expanding a group lists each call; expanding a call shows its result.
  await user.click(screen.getByRole("button", { name: /Read socket\.ts, searched onclose/ }));
  expect(screen.getByText(en.chat.activity.batchHeader.replace("{count}", "2"))).toBeInTheDocument();
  expect(screen.getByText("2 lines")).toBeInTheDocument();
  expect(screen.getByText("1 match")).toBeInTheDocument();

  await user.click(screen.getByText("Read").closest('[role="button"]') as HTMLElement);
  expect(await screen.findByText("two")).toBeInTheDocument();
}

describe("the interleaved activity flow", () => {
  it("draws a live turn as text, grouped calls, reasoning and a footer, and expands to results", async () => {
    await openConversation();
    broadcast(TURN.map((event) => ({ type: "agent_event", event })));
    await expectFlow();
  });

  it("draws the same turn identically when it arrives as replayed history", async () => {
    await openConversation();
    broadcast([{ type: "history_page", messages: TURN.map((event) => ({ type: "agent_event", event })), cursor: 0, hasMore: false }]);
    await expectFlow();
  });

  it("shows the running clock on the stop button and drops it when the turn ends", async () => {
    await openConversation();
    broadcast([{ type: "turn_state", active: true, startedAt: Date.now() - 8_000 }]);
    const stop = await screen.findByRole("button", { name: en.common.stop });
    expect(stop).toHaveTextContent(/^\s*(8|9)s\s*/);

    broadcast([{ type: "agent_event", event: { type: "turn_ended", stopped: false, durationMs: 9000 } }]);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: en.common.stop })).toBeNull());
  });
});
