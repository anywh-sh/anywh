import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkBlock } from "@/components/chat/activity/WorkBlock";
import { Elapsed } from "@/components/chat/activity/Elapsed";
import { buildTimeline, type WorkItem } from "@/lib/format/activity";
import { OpenState, OpenStateContext, WORK_LINGER_MS } from "@/lib/format/openState";
import type { ToolCallEntry, LogEntry } from "@/hooks/relay/useMessageLog";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let seq = 0;
function call(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  seq += 1;
  return { kind: "tool-call", id: `c${seq}`, toolUseId: `t${seq}`, name: "Read", toolKind: "read", input: {}, isError: false, done: true, ...overrides };
}
const read = (path: string, o: Partial<ToolCallEntry> = {}) => call({ subject: { kind: "read", path }, ...o });
const shell = (command: string, o: Partial<ToolCallEntry> = {}) => call({ toolKind: "shell", name: "Bash", subject: { kind: "shell", command }, ...o });
const FOOTER: LogEntry = { kind: "turn-footer", id: "footer", sentAt: 0, text: "" };

/** A work block drawn from log entries the way the log draws it, in its own
 * open state (the default context is shared by every test in the file). A
 * turn with no footer is still running. */
function renderBlock(entries: LogEntry[], options: { onOpenPath?: (path: string) => void; onCopy?: (text: string) => void; state?: OpenState } = {}) {
  const state = options.state ?? new OpenState();
  const itemOf = (log: LogEntry[]): WorkItem => buildTimeline(log).find((item): item is WorkItem => item.kind === "work") as WorkItem;
  const ui = (log: LogEntry[]) => (
    <OpenStateContext.Provider value={state}>
      <WorkBlock item={itemOf(log)} attributionByToolUseId={{}} cwd="/w" onCopy={options.onCopy ?? (() => {})} onOpenPath={options.onOpenPath} />
    </OpenStateContext.Provider>
  );
  const view = render(ui(entries));
  return { ...view, state, again: (log: LogEntry[]) => view.rerender(ui(log)) };
}

/** The block's heading line — "Working", "Worked for 5s". */
const header = () => screen.getByRole("button", { name: /^(Working|Worked)/ });

describe("WorkBlock", () => {
  it("is folded once finished, headed by how long the turn worked, and opens to its steps", async () => {
    const user = userEvent.setup();
    renderBlock([read("/w/a.ts", { startedAt: 1_000, endedAt: 3_000 }), shell("ls", { startedAt: 3_000, endedAt: 6_000 }), FOOTER]);
    expect(header()).toHaveTextContent("Worked for 5s");
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("a.ts")).toBeNull();
    await user.click(header());
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("ls")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("says just 'Worked' when the turn carries no timestamps, as in an older replay", () => {
    renderBlock([read("/w/a.ts"), FOOTER]);
    expect(header()).toHaveTextContent(/^Worked$/);
  });

  it("is open while the turn runs, with a clock, the present tense and no 'Done'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { container } = renderBlock([read("/w/a.ts", { startedAt: 7_000, endedAt: 7_500 }), shell("npm test", { done: false, startedAt: 8_000 })]);
    expect(header()).toHaveTextContent("Working3s");
    expect(header()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Running/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Read/ })).toBeInTheDocument();
    expect(screen.queryByText("Done")).toBeNull();
    expect(container.querySelector("section")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector(".animate-shimmer-window")).not.toBeNull();
  });

  it("draws a turn that is only reasoning so far as a heading and nothing under it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const { container } = renderBlock([{ kind: "thinking", id: "t", text: "", running: true, pending: true, startedAt: 500 }]);
    expect(header()).toHaveTextContent("Working1s");
    expect(container.querySelector("ol")).toBeNull();
  });

  it("puts reasoning and the agent's remarks on the timeline in order, between the calls", async () => {
    const user = userEvent.setup();
    const { container } = renderBlock([
      { kind: "text", id: "x", text: "Let me read the socket first.", streaming: false, sentAt: 0 },
      read("/w/socket.ts"),
      { kind: "thinking", id: "t", text: "the close handler never fires", running: false },
      shell("npm test"),
      FOOTER,
    ]);
    await user.click(header());
    expect(Array.from(container.querySelectorAll("ol > li")).map((li) => li.textContent)).toEqual([
      "Let me read the socket first.",
      expect.stringContaining("Read"),
      "the close handler never fires",
      expect.stringContaining("Ran"),
      "Done",
    ]);
  });

  it("says how many failed in the heading, and what failed on its step: the exit code and the first line of why", async () => {
    const user = userEvent.setup();
    renderBlock([shell("false", { isError: true, content: "\nError: build broke\nat x", outcome: { kind: "terminal", output: "", exitCode: 3 } }), FOOTER]);
    expect(header()).toHaveTextContent(/Worked.*1 failed/);
    await user.click(header());
    expect(screen.getByText("exit 3")).toBeInTheDocument();
    expect(screen.getByText("Error: build broke")).toBeInTheDocument();
  });

  it("does not say the work is done when the turn was stopped", async () => {
    const user = userEvent.setup();
    renderBlock([read("/w/a.ts"), { kind: "stopped", id: "s" }, FOOTER]);
    await user.click(header());
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByText("Done")).toBeNull();
  });

  describe("target chips", () => {
    const many = Array.from({ length: 6 }, (_, index) => read(`/w/f${index}.ts`));

    it("shows four, then '+N more' opens the rest and 'Show less' puts them back, per step", async () => {
      const user = userEvent.setup();
      renderBlock([...many, shell("ls"), shell("pwd"), FOOTER]);
      await user.click(header());
      expect(screen.getByText("f3.ts")).toBeInTheDocument();
      expect(screen.queryByText("f4.ts")).toBeNull();
      const more = screen.getByRole("button", { name: "+2 more" });
      expect(more).toHaveAttribute("aria-expanded", "false");
      await user.click(more);
      expect(screen.getByText("f5.ts")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Show less" }));
      expect(screen.queryByText("f5.ts")).toBeNull();
      // The shell step has two chips: nothing to expand.
      expect(screen.getAllByRole("button", { name: /more$/ })).toHaveLength(1);
    });

    it("keeps the whole path on the chip and shows the change on an edit", async () => {
      const user = userEvent.setup();
      renderBlock([call({ toolKind: "edit", name: "Edit", subject: { kind: "edit", path: "/w/src/MessageLog.tsx" }, outcome: { kind: "diff", path: "/w/src/MessageLog.tsx", hunks: [], added: 9, removed: 2 } }), FOOTER]);
      await user.click(header());
      const chip = screen.getByTitle("/w/src/MessageLog.tsx");
      expect(chip).toHaveTextContent("MessageLog.tsx");
      expect(chip).toHaveTextContent("+9");
      expect(chip).toHaveTextContent("−2");
    });

    it("opens a file from its chip, and is plain text where there is no file panel or no file", async () => {
      const user = userEvent.setup();
      const onOpenPath = vi.fn();
      renderBlock([read("/w/src/a.ts"), shell("ls"), FOOTER], { onOpenPath });
      await user.click(header());
      await user.click(screen.getByTitle("/w/src/a.ts"));
      expect(onOpenPath).toHaveBeenCalledWith("/w/src/a.ts");
      expect(screen.getByTitle("ls").tagName).toBe("SPAN");
      cleanup();
      renderBlock([read("/w/src/a.ts"), FOOTER]);
      await user.click(header());
      expect(screen.getByTitle("/w/src/a.ts").tagName).toBe("SPAN");
    });
  });

  describe("a step's calls", () => {
    it("open from the step's own verb, with the arguments highlighted and copyable and the result under a label of its own", async () => {
      const user = userEvent.setup();
      const onCopy = vi.fn();
      renderBlock([call({ name: "mcp__linear__get", toolKind: "mcp", subject: { kind: "mcp", server: "linear", tool: "get" }, input: { id: "ENG-42" }, content: '{"title":"Fix it"}' }), FOOTER], { onCopy });
      await user.click(header());
      await user.click(screen.getByRole("button", { name: /^Queried/ }));
      await user.click(screen.getAllByText("linear.get")[1].closest('[role="button"]') as HTMLElement);
      expect(screen.getByText("Arguments")).toBeInTheDocument();
      expect(screen.getByText("Result")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Copy arguments" }));
      expect(onCopy).toHaveBeenCalledWith(JSON.stringify({ id: "ENG-42" }, null, 2));
    });

    it("draw a call with no interpretation from its raw name and text", async () => {
      const user = userEvent.setup();
      const { container } = renderBlock([call({ name: "Mystery", toolKind: "other", content: "raw result" }), FOOTER]);
      await user.click(header());
      expect(screen.getByTitle("Mystery")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /^Used/ }));
      await user.click(container.querySelector('[role="button"]') as HTMLElement);
      expect(await screen.findByText("raw result")).toBeInTheDocument();
    });
  });

  describe("opening and folding", () => {
    it("folds itself a moment after the turn ends", () => {
      vi.useFakeTimers();
      const running = [read("/w/a.ts")];
      const { again } = renderBlock(running);
      expect(header()).toHaveAttribute("aria-expanded", "true");
      again([...running, FOOTER]);
      expect(header()).toHaveAttribute("aria-expanded", "true");
      act(() => void vi.advanceTimersByTime(WORK_LINGER_MS - 10));
      expect(header()).toHaveAttribute("aria-expanded", "true");
      act(() => void vi.advanceTimersByTime(20));
      expect(header()).toHaveAttribute("aria-expanded", "false");
    });

    it("stays as the user left it, open or closed, when the turn ends", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: (ms) => void vi.advanceTimersByTime(ms) });
      const running = [read("/w/a.ts")];
      const { again } = renderBlock(running);
      await user.click(header()); // closes it mid-turn
      expect(header()).toHaveAttribute("aria-expanded", "false");
      again([...running, FOOTER]);
      act(() => void vi.advanceTimersByTime(WORK_LINGER_MS * 2));
      expect(header()).toHaveAttribute("aria-expanded", "false");
      cleanup();
      const finished = [read("/w/b.ts"), FOOTER];
      const open = renderBlock(finished);
      await user.click(header());
      open.again(finished);
      act(() => void vi.advanceTimersByTime(WORK_LINGER_MS * 2));
      expect(header()).toHaveAttribute("aria-expanded", "true");
    });

    it("keeps what the user opened across an unmount, as when the virtualized list scrolls it away", async () => {
      const user = userEvent.setup();
      const state = new OpenState();
      const log = [read("/w/a.ts"), FOOTER];
      const { unmount } = renderBlock(log, { state });
      await user.click(header());
      expect(screen.getByText("a.ts")).toBeInTheDocument();
      unmount();
      renderBlock(log, { state });
      expect(screen.getByText("a.ts")).toBeInTheDocument();
    });
  });
});

describe("Elapsed", () => {
  it("ticks by itself while open and stops at the end time once known", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { container, rerender } = render(<Elapsed startedAt={0} />);
    expect(container.textContent).toBe("1s");
    act(() => void vi.advanceTimersByTime(2_000));
    expect(container.textContent).toBe("3s");
    rerender(<Elapsed startedAt={0} endedAt={3_500} />);
    act(() => void vi.advanceTimersByTime(5_000));
    expect(container.textContent).toBe("3s");
  });

  it("starts at 0s, never a decimal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(200);
    const { container } = render(<Elapsed startedAt={0} />);
    expect(container.textContent).toBe("0s");
  });

  it("moves to minutes past sixty seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(75_000);
    const { container } = render(<Elapsed startedAt={0} />);
    expect(container.textContent).toBe("1m 15s");
  });
});
