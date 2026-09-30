import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaunchedInBackground } from "@/components/chat/LaunchedInBackground";
import { en } from "@/i18n/en";
import type { Profile } from "@/lib/profiles/profiles";

vi.mock("@/lib/relay/backgroundJobClient", () => ({
  getBackgroundJobLog: vi.fn(() => Promise.resolve("installing deps\nready on :5173\n")),
}));

const profile = { id: "p1", label: "p1" } as Profile;
const base = { profile, sessionId: "s1", live: true };

const copy = en.chat.launchedInBackground;

afterEach(() => {
  cleanup();
});

describe("LaunchedInBackground", () => {
  it("renders nothing with no jobs and no running subagent call", () => {
    const { container } = render(
      <LaunchedInBackground {...base} jobs={[]} onCancelJob={() => {}} agents={[]} onStopAgent={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a proc card closed by default, and its stop action once expanded", async () => {
    const user = userEvent.setup();
    const onCancelJob = vi.fn();
    render(
      <LaunchedInBackground
        {...base}
        jobs={[{ id: "j1", label: "pnpm dev --host", startedAt: Date.now(), pid: 4821 }]}
        onCancelJob={onCancelJob}
        agents={[]}
        onStopAgent={() => {}}
      />,
    );

    expect(screen.getByText("pnpm dev --host")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.stopProcess })).not.toBeInTheDocument();
    // pid is on the wire (BackgroundJobSummary.pid) but deliberately not
    // shown — the meta line is elapsed time only.
    expect(screen.queryByText(/pid/i)).not.toBeInTheDocument();

    await user.click(screen.getByText("pnpm dev --host"));
    const stopButton = screen.getByRole("button", { name: copy.stopProcess });
    await user.click(stopButton);
    expect(onCancelJob).toHaveBeenCalledWith("j1");
  });

  it("shows a running subagent card, with a fallback name and only a stop action", async () => {
    const user = userEvent.setup();
    const onStopAgent = vi.fn();
    render(
      <LaunchedInBackground
        {...base}
        jobs={[]}
        onCancelJob={() => {}}
        agents={[{ toolUseId: "tu1", description: null, startedAt: null, activity: null, toolCalls: [], toolUses: null }]}
        onStopAgent={onStopAgent}
      />,
    );

    expect(screen.getByText(copy.agentFallbackName)).toBeInTheDocument();
    await user.click(screen.getByText(copy.agentFallbackName));
    await user.click(screen.getByRole("button", { name: copy.stopAgent }));
    expect(onStopAgent).toHaveBeenCalled();
  });

  it("shows what a running job printed last, and the fuller tail once expanded", async () => {
    const user = userEvent.setup();
    render(
      <LaunchedInBackground
        {...base}
        jobs={[{ id: "j1", label: "pnpm dev", startedAt: Date.now(), pid: 1 }]}
        onCancelJob={() => {}}
        agents={[]}
        onStopAgent={() => {}}
      />,
    );

    expect(await screen.findByText("ready on :5173")).toBeInTheDocument();
    await user.click(screen.getByText("pnpm dev"));
    expect(screen.getByText(/installing deps\s+ready on :5173/)).toBeInTheDocument();
  });

  it("shows a subagent's current activity, elapsed time and tool count, and its tool calls once expanded", async () => {
    const user = userEvent.setup();
    render(
      <LaunchedInBackground
        {...base}
        jobs={[]}
        onCancelJob={() => {}}
        agents={[
          {
            toolUseId: "tu1",
            description: "auditing hooks",
            startedAt: Date.now() - 65_000,
            activity: "Reading useEffect.ts",
            toolCalls: ["Read src/app.ts", "Grep useEffect"],
            toolUses: 2,
          },
        ]}
        onStopAgent={() => {}}
      />,
    );

    expect(screen.getByText("Reading useEffect.ts")).toBeInTheDocument();
    expect(screen.getByText(/1m 5s · 2 tools/)).toBeInTheDocument();
    await user.click(screen.getByText("auditing hooks"));
    expect(screen.getByText(/Read src\/app\.ts\s+Grep useEffect/)).toBeInTheDocument();
  });
});
