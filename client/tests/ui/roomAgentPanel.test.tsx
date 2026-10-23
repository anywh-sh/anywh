import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { seedShellProfile, SHELL_TEST_PROFILE } from "./helpers/seedProfile";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocaleProvider } from "@/i18n";
import { en } from "@/i18n/en";
import { AgentPanel } from "@/components/sala/AgentPanel";
import type { AgentEvent } from "@/lib/relay/relay-types";
import type { RoomAgent, RoomWorktree } from "@/lib/relay/roomClient";
import foreground from "./fixtures/subagent-fg.json";

// Same Tauri seams as sendMessage.test.tsx.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => undefined) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

const BRANCH = "anywh/stop-the-spinner-in-message-log-on-the-phone";

function worker(over: Partial<RoomAgent> = {}): RoomAgent {
  return { agentId: "worker-1", role: "worker", parentId: "room-1", title: "Stop the spinner", runtime: "claude", model: "haiku", createdBy: "agent", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, connectors: [], ...over };
}

function worktree(over: Partial<RoomWorktree> = {}): RoomWorktree {
  return { id: "wt-1", agentId: "worker-1", repoRoot: "/repo", path: "/repo/.wt/1", branch: BRANCH, state: "active", phase: "in_use", commitsAhead: 2, integrated: false, ...over };
}

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay("on it");
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

/** A room's side panel open on a worker, as `RoomPanel` draws it. */
function openWorker(worktrees: RoomWorktree[] = []): void {
  render(
    <LocaleProvider>
      <TooltipProvider>
        <AgentPanel
          profile={SHELL_TEST_PROFILE}
          roomId="room-1"
          agent={worker()}
          parent={undefined}
          modelLabel="Haiku"
          observedSince={0}
          worktrees={worktrees}
          onClose={() => undefined}
          onOpenInTab={() => undefined}
          onDelegate={() => undefined}
          onStop={() => undefined}
          onResume={() => undefined}
          onRemove={() => undefined}
        />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

const workerSockets = () => relay.sockets.filter((s) => s.url.includes("session=worker-1"));
const panel = () => document.querySelector<HTMLElement>('aside[data-panel="agent"]')!;
const delegatedRow = () => panel().querySelector<HTMLElement>(".sala-side-by")!;

describe("a room worker's side panel", () => {
  it("is the agent's whole conversation, as a tab shows it, over one connection", async () => {
    openWorker();
    await vi.waitFor(() => expect(workerSockets()).toHaveLength(1));
    const events: AgentEvent[] = [
      { type: "turn_started", startedAt: 1_700_000_000_000 },
      { type: "text", text: "Reading MessageLog first." },
      // A real `Agent` call as the relay maps it (see subagentCard.test.tsx).
      ...(foreground as AgentEvent[]).slice(0, 2),
    ];
    for (const event of events) workerSockets()[0].emitMessage({ type: "agent_event", event });

    expect(await within(panel()).findByText("Reading MessageLog first.")).toBeInTheDocument();
    // The call's own card, as in a tab.
    expect(await within(panel()).findByText("probe fg")).toBeInTheDocument();
    expect(within(panel()).getByText(en.chat.launchedInBackground.agentBadge)).toBeInTheDocument();
    // The summary it replaced is gone: no report, no "Work" section, no reply box.
    expect(within(panel()).queryByText("Work")).not.toBeInTheDocument();
    expect(workerSockets()).toHaveLength(1);
  });

  it("sends from the compact box through the conversation, which shows the message at once", async () => {
    const user = userEvent.setup();
    openWorker();
    const box = await within(panel()).findByLabelText(en.sala.panel.agent.messagePlaceholder);
    await user.type(box, "Also check the iPad{Enter}");

    await vi.waitFor(() => expect(relay.sent.some((s) => s.url.includes("session=worker-1") && s.message.type === "user_message" && s.message.text === "Also check the iPad")).toBe(true));
    expect(await within(panel()).findByText("Also check the iPad")).toBeInTheDocument();
    expect(await within(panel()).findByText("on it")).toBeInTheDocument();
    expect(box).toHaveValue("");
    expect(workerSockets()).toHaveLength(1);
  });

  it("names the worktree at the end of the 'Delegated by' line, whole in its tooltip", () => {
    openWorker([worktree(), worktree({ id: "wt-2", branch: "anywh/second", integrated: true, commitsAhead: 1 })]);
    const row = delegatedRow();
    expect(row).toHaveTextContent(en.sala.panel.agent.delegatedBy.replace("{title}", en.sala.orchestrator));
    const mark = within(row).getByLabelText(en.sala.panel.agent.worktree.replace("{branch}", BRANCH));
    expect(mark).toHaveTextContent(BRANCH);
    expect(mark).toHaveTextContent("+1");
    expect(mark.getAttribute("title")).toBe(`${BRANCH} · 2 commits · not integrated\nanywh/second · 1 commit · integrated`);
  });

  it("keeps the 'Delegated by' line as it is when the agent has no worktree", () => {
    openWorker();
    expect(delegatedRow()).toHaveTextContent(en.sala.panel.agent.delegatedBy.replace("{title}", en.sala.orchestrator));
    expect(delegatedRow().querySelector(".sala-side-wt")).toBeNull();
  });
});
