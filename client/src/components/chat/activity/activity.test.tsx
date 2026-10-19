import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityGroup } from "@/components/chat/activity/ActivityGroup";
import { Elapsed } from "@/components/chat/activity/Elapsed";
import { ThinkingRow } from "@/components/chat/activity/ThinkingRow";
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

const noop = () => {};

function group(calls: ToolCallEntry[], onOpenPath?: (p: string) => void) {
  return <ActivityGroup id={calls[0].id} calls={calls} attributionByToolUseId={{}} cwd="/w" onCopy={noop} onOpenPath={onOpenPath} />;
}

/** The group's own button — the line that counts, "Used 2 tools" / "Using 2 tools…". */
const groupButton = () => screen.getByRole("button", { name: /^(Used|Using) \d+ tools?/ });

describe("ActivityGroup", () => {
  it("counts its calls in one line instead of narrating them, and lists a row per call when opened", async () => {
    const user = userEvent.setup();
    render(group([call({ subject: { kind: "read", path: "/w/a.ts" } }), call({ toolKind: "shell", name: "Bash", subject: { kind: "shell", command: "ls" } })]));
    expect(groupButton()).toHaveTextContent("Used 2 tools");
    expect(screen.queryByText("a.ts")).toBeNull(); // the target belongs to its row, not to the line
    await user.click(groupButton());
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(2);
  });

  it("says one call in the singular", () => {
    render(group([call({ subject: { kind: "read", path: "/w/a.ts" } })]));
    expect(groupButton()).toHaveTextContent("Used 1 tool");
  });

  it("clicking a file target opens the file and leaves the row closed", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    render(group([call({ subject: { kind: "read", path: "/w/src/a.ts" }, outcome: { kind: "code", path: "/w/src/a.ts", lines: ["x"] } })], onOpenPath));
    await user.click(groupButton());
    await user.click(screen.getByTitle("Open file"));
    expect(onOpenPath).toHaveBeenCalledWith("/w/src/a.ts");
    expect(screen.queryByText("path")).toBeNull();
  });

  it("does not offer to open a target that is not a file, or anything on a client with no file panel", async () => {
    const user = userEvent.setup();
    render(group([call({ toolKind: "shell", name: "Bash", subject: { kind: "shell", command: "ls" } })], vi.fn()));
    await user.click(groupButton());
    expect(screen.queryByTitle("Open file")).toBeNull();
    cleanup();
    render(group([call({ subject: { kind: "read", path: "/w/a.ts" } })]));
    await user.click(groupButton());
    expect(screen.queryByTitle("Open file")).toBeNull();
  });

  it("says how many failed in the line, and shows the exit code on the failed row", async () => {
    const user = userEvent.setup();
    render(group([call({ toolKind: "shell", name: "Bash", subject: { kind: "shell", command: "false" }, isError: true, outcome: { kind: "terminal", output: "", exitCode: 3 } })]));
    expect(groupButton()).toHaveTextContent("1 failed");
    await user.click(groupButton());
    expect(screen.getByText("exit 3")).toBeInTheDocument();
  });

  it("counts the calls so far while any is running, with the group's clock", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(10_000);
    render(group([call({ subject: { kind: "read", path: "/w/a.ts" }, startedAt: 7_000, endedAt: 7_500 }), call({ toolKind: "shell", name: "Bash", subject: { kind: "shell", command: "npm test" }, done: false, startedAt: 8_000 })]));
    expect(groupButton()).toHaveTextContent("Using 2 tools…");
    expect(groupButton()).toHaveTextContent("· 3s");
    // The running row keeps the gerund and its own clock.
    await userEvent.setup({ advanceTimers: (ms) => void vi.advanceTimersByTime(ms) }).click(groupButton());
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("2s")).toBeInTheDocument();
  });

  it("shows the group's total time once every call ended, from the first start to the last end", () => {
    render(group([call({ startedAt: 1_000, endedAt: 4_000 }), call({ startedAt: 1_000, endedAt: 3_000 }), call({ startedAt: 5_000, endedAt: 6_000 })]));
    expect(groupButton()).toHaveTextContent("Used 3 tools · 5s");
  });

  it("leaves the time out when a call has no timestamps, as in an older replay", () => {
    render(group([call({ startedAt: 1_000, endedAt: 4_000 }), call()]));
    expect(groupButton()).toHaveTextContent(/^Used 2 tools$/);
  });

  it("marks each row by how its call ended: a check with the time, a failure, nothing for a stopped one", async () => {
    const user = userEvent.setup();
    const { container } = render(
      group([
        call({ subject: { kind: "read", path: "/w/ok.ts" }, startedAt: 1_000, endedAt: 1_420 }),
        call({ toolKind: "shell", name: "Bash", subject: { kind: "shell", command: "boom" }, isError: true }),
        call({ toolKind: "shell", name: "Bash", subject: { kind: "shell", command: "stopped" }, isError: true, aborted: true }),
      ]),
    );
    await user.click(groupButton());
    expect(screen.getByText("420ms")).toBeInTheDocument();
    expect(screen.getAllByText("Failed")).toHaveLength(1); // the stopped call is not a failure
    // One check (the read) in the rows; the stopped and the failed calls have none.
    expect(container.querySelectorAll("svg.lucide-check")).toHaveLength(1);
  });

  it("draws a call with no interpretation from its raw name and text", async () => {
    const user = userEvent.setup();
    render(group([call({ name: "Mystery", toolKind: "other", content: "raw result" })]));
    await user.click(groupButton());
    await user.click(screen.getByText("Used").closest('[role="button"]') as HTMLElement);
    expect(await screen.findByText("raw result")).toBeInTheDocument();
  });

  it("shows an MCP call's arguments, highlighted and copyable, and its result under a label of its own", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    render(
      <ActivityGroup
        id="m"
        calls={[call({ name: "mcp__linear__get", toolKind: "mcp", subject: { kind: "mcp", server: "linear", tool: "get" }, input: { id: "ENG-42" }, content: '{"title":"Fix it"}' })]}
        attributionByToolUseId={{}}
        cwd="/w"
        onCopy={onCopy}
      />,
    );
    await user.click(groupButton());
    await user.click(screen.getByText("linear.get").closest('[role="button"]') as HTMLElement);
    expect(screen.getByText("Arguments")).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText('"ENG-42"')).toBeInTheDocument();
    // One copy button per block — the input line must not add a second one for the result.
    expect(screen.getAllByRole("button", { name: /^Copy / }).map((b) => b.getAttribute("aria-label"))).toEqual(["Copy arguments", "Copy result"]);
    await user.click(screen.getByRole("button", { name: "Copy arguments" }));
    expect(onCopy).toHaveBeenCalledWith(JSON.stringify({ id: "ENG-42" }, null, 2));
  });

  it("does not repeat as JSON what a call's own input line already says", async () => {
    const user = userEvent.setup();
    render(group([call({ subject: { kind: "read", path: "/w/a.ts" }, input: { file_path: "/w/a.ts" }, outcome: { kind: "code", path: "/w/a.ts", lines: ["x"] } })]));
    await user.click(groupButton());
    await user.click(screen.getByText("a.ts").closest('[role="button"]') as HTMLElement);
    expect(screen.getByText("path")).toBeInTheDocument();
    expect(screen.queryByText("Arguments")).toBeNull();
  });

  it("keeps a group open across an unmount, as when the virtualized list scrolls it away", async () => {
    const user = userEvent.setup();
    const calls = [call({ subject: { kind: "read", path: "/w/a.ts" } })];
    const { unmount } = render(group(calls));
    await user.click(groupButton());
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    unmount();
    render(group(calls));
    expect(screen.getByText("a.ts")).toBeInTheDocument();
  });
});

describe("ThinkingRow", () => {
  const entry = (overrides: Partial<Extract<LogEntry, { kind: "thinking" }>> = {}): Extract<LogEntry, { kind: "thinking" }> => ({
    kind: "thinking",
    id: `th${(seq += 1)}`,
    text: "",
    running: false,
    ...overrides,
  });

  it("says how long it thought, without an arrow when there is no text", () => {
    render(<ThinkingRow entry={entry({ startedAt: 0, endedAt: 3000 })} />);
    expect(screen.getByText("Thought for 3s")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says just 'Thought' when no time was reported", () => {
    render(<ThinkingRow entry={entry()} />);
    expect(screen.getByText("Thought")).toBeInTheDocument();
  });

  it("opens to its text when it has any", async () => {
    const user = userEvent.setup();
    render(<ThinkingRow entry={entry({ text: "because of the cache", startedAt: 0, endedAt: 1000 })} />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByText("because of the cache")).toBeInTheDocument();
  });

  it("marks a finished block with a check and a running one with a spinner and the sweeping label", () => {
    const { container, rerender } = render(<ThinkingRow entry={entry({ startedAt: 0, endedAt: 3000 })} />);
    expect(container.querySelector("svg.lucide-check")).not.toBeNull();
    expect(container.querySelector(".animate-shimmer-window")).toBeNull();
    rerender(<ThinkingRow entry={entry({ running: true, startedAt: 0 })} />);
    expect(container.querySelector("svg.lucide-check")).toBeNull();
    expect(container.querySelector(".animate-shimmer-window")).not.toBeNull();
  });

  it("while running keeps the verb it drew, however often it re-renders", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const running = entry({ running: true, startedAt: 4_000 });
    const { container, rerender } = render(<ThinkingRow entry={running} />);
    const first = container.textContent;
    expect(first).toMatch(/…/);
    rerender(<ThinkingRow entry={{ ...running }} />);
    expect(container.textContent).toBe(first);
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
