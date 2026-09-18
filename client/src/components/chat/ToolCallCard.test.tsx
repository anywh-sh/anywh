import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolCallCard } from "./ToolCallCard";
import { en } from "@/i18n/en";
import type { LogEntry } from "@/hooks/relay/useMessageLog";

afterEach(() => cleanup());

const CWD = "/home/wil/app";

function editUse(filePath = `${CWD}/src/relay/socket.ts`): Extract<LogEntry, { kind: "tool-use" }> {
  return { kind: "tool-use", id: "u1", toolUseId: "t1", name: "Edit", input: { file_path: filePath } };
}

function editResult(): Extract<LogEntry, { kind: "tool-result" }> {
  return {
    kind: "tool-result",
    id: "r1",
    toolUseId: "t1",
    content: "",
    isError: false,
    structuredPatch: [
      { oldStart: 41, oldLines: 4, newStart: 41, newLines: 12, lines: [" class TrackedSocket", "-old line", "+new line", "+another"] },
    ],
  };
}

describe("ToolCallCard", () => {
  it("names the file the way the user would, not as the relay's absolute path", () => {
    render(<ToolCallCard use={editUse()} result={editResult()} cwd={CWD} />);

    expect(screen.getByText("src/relay/socket.ts")).toBeInTheDocument();
    expect(screen.queryByText(`${CWD}/src/relay/socket.ts`)).not.toBeInTheDocument();
  });

  it("summarises the diff in the header", () => {
    render(<ToolCallCard use={editUse()} result={editResult()} cwd={CWD} />);

    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
  });

  it("opens the touched file with the path the panel can resolve", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    render(<ToolCallCard use={editUse()} result={editResult()} cwd={CWD} onOpenPath={onOpenPath} />);

    await user.click(screen.getByRole("button", { name: en.chat.toolCall.viewFile }));

    // The absolute path, not the shortened one on screen: trimming is for
    // reading, and the panel resolves against the relay's own filesystem.
    expect(onOpenPath).toHaveBeenCalledWith(`${CWD}/src/relay/socket.ts`);
  });

  // Compact viewports and iOS have no file panel at all, which is exactly
  // what `onOpenPath` being absent means — offering the button there would
  // be a control that does nothing.
  it("hides the view-file button where there is no file panel", () => {
    render(<ToolCallCard use={editUse()} result={editResult()} cwd={CWD} />);

    expect(screen.queryByRole("button", { name: en.chat.toolCall.viewFile })).not.toBeInTheDocument();
  });

  it("offers no file to open for a tool that doesn't touch one", () => {
    const bash: Extract<LogEntry, { kind: "tool-use" }> = {
      kind: "tool-use",
      id: "u2",
      name: "Bash",
      input: { command: "npm test" },
    };
    render(<ToolCallCard use={bash} cwd={CWD} onOpenPath={vi.fn()} />);

    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.chat.toolCall.viewFile })).not.toBeInTheDocument();
  });

  function bashUse(): Extract<LogEntry, { kind: "tool-use" }> {
    return { kind: "tool-use", id: "u3", toolUseId: "t3", name: "Bash", input: { command: "cat big.log" } };
  }

  it("shows the context-cost badge on a tool with no diff of its own (Read/Bash), the headline case the card exists for", () => {
    render(<ToolCallCard use={bashUse()} cwd={CWD} attribution={{ tokens: 13_472, estimated: false }} />);

    expect(screen.getByText("+13k")).toBeInTheDocument();
  });

  it("hides the badge below the ~1,000 token floor — the point is finding the big one, not annotating every small call", () => {
    render(<ToolCallCard use={bashUse()} cwd={CWD} attribution={{ tokens: 111, estimated: false }} />);

    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it("marks a divided (parallel-batch) badge with a trailing ~ and an explanatory tooltip", () => {
    render(<ToolCallCard use={bashUse()} cwd={CWD} attribution={{ tokens: 5_000, estimated: true }} />);

    const badge = screen.getByText("+5k~");
    expect(badge).toHaveAttribute("title", en.chat.toolCall.attributionEstimatedHint);
  });

  it("prefers the diff badge over the context-cost one when both would apply — they don't collide in practice, but if they did, the more specific one wins", () => {
    render(<ToolCallCard use={editUse()} result={editResult()} cwd={CWD} attribution={{ tokens: 5_000, estimated: false }} />);

    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.queryByText("+5k")).not.toBeInTheDocument();
  });
});
