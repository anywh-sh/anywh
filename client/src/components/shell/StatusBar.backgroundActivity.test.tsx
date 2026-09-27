import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusBar } from "@/components/shell/StatusBar";
import { en } from "@/i18n/en";
import type { BackgroundActivityItem } from "@/hooks/useBackgroundActivity";

const copy = en.shell.statusBar.backgroundActivity;

afterEach(() => {
  cleanup();
});

const runningAgent: BackgroundActivityItem = {
  id: "tab:t2",
  kind: "agent",
  tabId: "t2",
  profileId: "p1",
  name: "Other conversation",
  tail: "",
  status: "run",
  time: 0,
};

const failedProc: BackgroundActivityItem = {
  id: "j1",
  kind: "proc",
  tabId: "t1",
  profileId: "p1",
  name: "systemctl restart relay",
  tail: "exit 1",
  status: "fail",
  time: Date.now(),
  pid: 123,
};

function baseProps() {
  return {
    profile: null,
    sessionId: null,
    isRunning: false,
    windowFocused: true,
    onOpenUpdateModal: () => {},
  };
}

describe("StatusBar background activity chip", () => {
  it("reads 'nothing running' with an empty list", () => {
    render(
      <StatusBar
        {...baseProps()}
        backgroundActivity={[]}
        onOpenBackgroundActivityItem={() => {}}
        onStopBackgroundActivityItem={() => {}}
        onDismissBackgroundActivityItem={() => {}}
        onStopAllBackgroundActivity={() => {}}
      />,
    );
    expect(screen.getByText(copy.none)).toBeInTheDocument();
  });

  it("counts running items, and appends the failed count", () => {
    render(
      <StatusBar
        {...baseProps()}
        backgroundActivity={[runningAgent, failedProc]}
        onOpenBackgroundActivityItem={() => {}}
        onStopBackgroundActivityItem={() => {}}
        onDismissBackgroundActivityItem={() => {}}
        onStopAllBackgroundActivity={() => {}}
      />,
    );
    const expected = `${copy.running.replace("{count}", "1")} · ${copy.failedSuffix.replace("{count}", "1")}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("opens the panel on click and shows every item, running before failed", async () => {
    const user = userEvent.setup();
    render(
      <StatusBar
        {...baseProps()}
        backgroundActivity={[runningAgent, failedProc]}
        onOpenBackgroundActivityItem={() => {}}
        onStopBackgroundActivityItem={() => {}}
        onDismissBackgroundActivityItem={() => {}}
        onStopAllBackgroundActivity={() => {}}
      />,
    );

    await user.click(screen.getByTitle(copy.chipTitle));
    expect(await screen.findByText(copy.heading)).toBeInTheDocument();
    expect(screen.getByText("Other conversation")).toBeInTheDocument();
    expect(screen.getByText("systemctl restart relay")).toBeInTheDocument();
  });

  it("shows the empty state once nothing is left", async () => {
    const user = userEvent.setup();
    render(
      <StatusBar
        {...baseProps()}
        backgroundActivity={[]}
        onOpenBackgroundActivityItem={() => {}}
        onStopBackgroundActivityItem={() => {}}
        onDismissBackgroundActivityItem={() => {}}
        onStopAllBackgroundActivity={() => {}}
      />,
    );
    await user.click(screen.getByTitle(copy.chipTitle));
    expect(await screen.findByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it("a running item's 'stop' calls onStopBackgroundActivityItem with that item", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <StatusBar
        {...baseProps()}
        backgroundActivity={[runningAgent]}
        onOpenBackgroundActivityItem={() => {}}
        onStopBackgroundActivityItem={onStop}
        onDismissBackgroundActivityItem={() => {}}
        onStopAllBackgroundActivity={() => {}}
      />,
    );
    await user.click(screen.getByTitle(copy.chipTitle));
    await user.click(await screen.findByRole("button", { name: copy.stop }));
    expect(onStop).toHaveBeenCalledWith(runningAgent);
  });

  it("a failed item only offers 'descartar', never 'abrir'/'parar'", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <StatusBar
        {...baseProps()}
        backgroundActivity={[failedProc]}
        onOpenBackgroundActivityItem={() => {}}
        onStopBackgroundActivityItem={() => {}}
        onDismissBackgroundActivityItem={onDismiss}
        onStopAllBackgroundActivity={() => {}}
      />,
    );
    await user.click(screen.getByTitle(copy.chipTitle));
    expect(screen.queryByRole("button", { name: copy.open })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.stop })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: copy.dismiss }));
    expect(onDismiss).toHaveBeenCalledWith(failedProc);
  });

  it("'abrir' closes the panel and calls onOpenBackgroundActivityItem", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <StatusBar
        {...baseProps()}
        backgroundActivity={[runningAgent]}
        onOpenBackgroundActivityItem={onOpen}
        onStopBackgroundActivityItem={() => {}}
        onDismissBackgroundActivityItem={() => {}}
        onStopAllBackgroundActivity={() => {}}
      />,
    );
    await user.click(screen.getByTitle(copy.chipTitle));
    await user.click(await screen.findByRole("button", { name: copy.open }));
    expect(onOpen).toHaveBeenCalledWith(runningAgent);
    expect(screen.queryByText(copy.heading)).not.toBeInTheDocument();
  });

  it("shows the 'stop all' footer only when at least one item is running", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <StatusBar
        {...baseProps()}
        backgroundActivity={[failedProc]}
        onOpenBackgroundActivityItem={() => {}}
        onStopBackgroundActivityItem={() => {}}
        onDismissBackgroundActivityItem={() => {}}
        onStopAllBackgroundActivity={() => {}}
      />,
    );
    await user.click(screen.getByTitle(copy.chipTitle));
    expect(await screen.findByText(copy.heading)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.stopAll })).not.toBeInTheDocument();

    rerender(
      <StatusBar
        {...baseProps()}
        backgroundActivity={[runningAgent, failedProc]}
        onOpenBackgroundActivityItem={() => {}}
        onStopBackgroundActivityItem={() => {}}
        onDismissBackgroundActivityItem={() => {}}
        onStopAllBackgroundActivity={() => {}}
      />,
    );
    expect(await screen.findByRole("button", { name: copy.stopAll })).toBeInTheDocument();
  });
});
