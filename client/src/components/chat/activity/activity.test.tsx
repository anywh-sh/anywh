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

describe("ActivityGroup", () => {
  it("opens from its summary line and lists a row per call", async () => {
    const user = userEvent.setup();
    render(group([call({ subject: { kind: "read", path: "/w/a.ts" } }), call({ toolKind: "shell", name: "Bash", subject: { kind: "shell", command: "ls" } })]));
    expect(screen.queryByText("a.ts")).toBeNull(); // only inside the summary sentence
    await user.click(screen.getByRole("button", { name: /Read a\.ts, ran ls/ }));
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(2);
  });

  it("clicking a file target opens the file and leaves the row closed", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    render(group([call({ subject: { kind: "read", path: "/w/src/a.ts" }, outcome: { kind: "code", path: "/w/src/a.ts", lines: ["x"] } })], onOpenPath));
    await user.click(screen.getByRole("button", { name: /Read a\.ts/ }));
    await user.click(screen.getByTitle("Open file"));
    expect(onOpenPath).toHaveBeenCalledWith("/w/src/a.ts");
    expect(screen.queryByText("path")).toBeNull();
  });

  it("does not offer to open a target that is not a file, or anything on a client with no file panel", async () => {
    const user = userEvent.setup();
    render(group([call({ toolKind: "shell", name: "Bash", subject: { kind: "shell", command: "ls" } })], vi.fn()));
    await user.click(screen.getByRole("button", { name: /Ran ls/ }));
    expect(screen.queryByTitle("Open file")).toBeNull();
    cleanup();
    render(group([call({ subject: { kind: "read", path: "/w/a.ts" } })]));
    await user.click(screen.getByRole("button", { name: /Read a\.ts/ }));
    expect(screen.queryByTitle("Open file")).toBeNull();
  });

  it("marks a failed call and shows its exit code, and says how many failed", async () => {
    const user = userEvent.setup();
    render(group([call({ toolKind: "shell", name: "Bash", subject: { kind: "shell", command: "false" }, isError: true, outcome: { kind: "terminal", output: "", exitCode: 3 } })]));
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Ran false/ }));
    expect(screen.getByText("exit 3")).toBeInTheDocument();
  });

  it("shows a running call in the gerund, with its own clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    render(group([call({ toolKind: "shell", name: "Bash", subject: { kind: "shell", command: "npm test" }, done: false, startedAt: 8_000 })]));
    expect(screen.getByText(/Running npm test…/)).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1000));
  });

  it("draws a call with no interpretation from its raw name and text", async () => {
    const user = userEvent.setup();
    render(group([call({ name: "Mystery", toolKind: "other", content: "raw result" })]));
    await user.click(screen.getByRole("button", { name: /Used Mystery/ }));
    await user.click(screen.getByText("Used").closest('[role="button"]') as HTMLElement);
    expect(await screen.findByText("raw result")).toBeInTheDocument();
  });

  it("keeps a group open across an unmount, as when the virtualized list scrolls it away", async () => {
    const user = userEvent.setup();
    const calls = [call({ subject: { kind: "read", path: "/w/a.ts" } })];
    const { unmount } = render(group(calls));
    await user.click(screen.getByRole("button", { name: /Read a\.ts/ }));
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
