import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaunchedInBackground } from "@/components/chat/LaunchedInBackground";
import { en } from "@/i18n/en";

const copy = en.chat.launchedInBackground;

afterEach(() => {
  cleanup();
});

describe("LaunchedInBackground", () => {
  it("renders nothing with no jobs and no running subagent call", () => {
    const { container } = render(
      <LaunchedInBackground jobs={[]} onCancelJob={() => {}} runningTaskCall={undefined} onStopAgent={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a proc card closed by default, and its stop action once expanded", async () => {
    const user = userEvent.setup();
    const onCancelJob = vi.fn();
    render(
      <LaunchedInBackground
        jobs={[{ id: "j1", label: "pnpm dev --host", startedAt: Date.now(), pid: 4821 }]}
        onCancelJob={onCancelJob}
        runningTaskCall={undefined}
        onStopAgent={() => {}}
      />,
    );

    expect(screen.getByText("pnpm dev --host")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.stopProcess })).not.toBeInTheDocument();

    await user.click(screen.getByText("pnpm dev --host"));
    const stopButton = screen.getByRole("button", { name: copy.stopProcess });
    await user.click(stopButton);
    expect(onCancelJob).toHaveBeenCalledWith("j1");
  });

  it("hides 'open in terminal' when there is no terminal to open", async () => {
    const user = userEvent.setup();
    render(
      <LaunchedInBackground
        jobs={[{ id: "j1", label: "pnpm dev", startedAt: Date.now(), pid: 1 }]}
        onCancelJob={() => {}}
        runningTaskCall={undefined}
        onStopAgent={() => {}}
      />,
    );
    await user.click(screen.getByText("pnpm dev"));
    expect(screen.queryByRole("button", { name: copy.openTerminal })).not.toBeInTheDocument();
  });

  it("shows a running subagent card, with a fallback name and only a stop action", async () => {
    const user = userEvent.setup();
    const onStopAgent = vi.fn();
    render(
      <LaunchedInBackground
        jobs={[]}
        onCancelJob={() => {}}
        runningTaskCall={{ toolUseId: "tu1", description: null }}
        onStopAgent={onStopAgent}
      />,
    );

    expect(screen.getByText(copy.agentFallbackName)).toBeInTheDocument();
    await user.click(screen.getByText(copy.agentFallbackName));
    await user.click(screen.getByRole("button", { name: copy.stopAgent }));
    expect(onStopAgent).toHaveBeenCalled();
  });
});
