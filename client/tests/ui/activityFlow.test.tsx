import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
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
  // One block for the whole turn, headed by how long it worked. A live turn
  // keeps it open a moment after it ends; wait for it to fold so the click
  // below opens it instead of closing it.
  const heading = await screen.findByRole("button", { name: /^Worked for/ });
  await waitFor(() => expect(heading).toHaveAttribute("aria-expanded", "false"));
  expect(heading).toHaveTextContent("· 1 failed");
  expect(screen.queryByText(/^Used \d+ tools?/)).toBeNull();
  expect(screen.queryByText(/^Thought/)).toBeNull();
  // The answer stands outside it, with nothing about time in its footer.
  expect(screen.getByText("All green now.")).toBeInTheDocument();
  expect(screen.queryByText(/worked 12s/)).toBeNull();

  // Open: the remark, then one step per kind of call in order, and the end.
  await user.click(heading);
  expect(screen.getByText("Let me look at the socket first.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Read/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Searched/ })).toBeInTheDocument();
  const ran = screen.getByRole("button", { name: /^Ran/ });
  expect(screen.getByTitle("/w/src/socket.ts")).toBeInTheDocument();
  expect(screen.getByTitle("onclose")).toBeInTheDocument();
  // The failed command and its retry are one step of two chips; the failure shows.
  expect(screen.getAllByTitle("npm test")).toHaveLength(2);
  expect(screen.getByText("exit 1")).toBeInTheDocument();
  expect(screen.getByText("Done")).toBeInTheDocument();

  // A step opens to its calls, and a call to its result.
  await user.click(screen.getByRole("button", { name: /^Read/ }));
  // The step says what its one call found; the call, once there, says it again.
  expect(screen.getAllByText("2 lines")).toHaveLength(2);
  await user.click(screen.getByText("Read", { selector: "span.shrink-0" }).closest('[role="button"]') as HTMLElement);
  expect(await screen.findByText("two")).toBeInTheDocument();
  await user.click(ran);
  expect(screen.getAllByText("exit 1").length).toBeGreaterThan(0);
}

describe("the interleaved activity flow", () => {
  it("draws a live turn as one block with the answer outside it, and expands to results", async () => {
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
    expect(stop).toHaveTextContent(/^\s*0:0(8|9)\s*/);

    broadcast([{ type: "agent_event", event: { type: "turn_ended", stopped: false, durationMs: 9000 } }]);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: en.common.stop })).toBeNull());
  });
});
