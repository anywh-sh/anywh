import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FilesPanel } from "./FilesPanel";
import { listFiles } from "@/lib/relay/filesClient";
import { en } from "@/i18n/en";
import type { useFileTabs } from "@/hooks/tabs/useFileTabs";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => [] }));
// The live watch is not what this is about, and it must not open sockets.
vi.mock("@/lib/profiles/connectionResolver", () => ({ resolveConnection: () => new Promise(() => {}) }));
vi.mock("@/lib/relay/filesClient", () => ({ listFiles: vi.fn(), uploadFile: vi.fn() }));

const profile = { id: "default", label: "Default", host: "127.0.0.1", relayPort: 8765 };

function makeFileTabs() {
  return {
    getTabs: () => ({ open: [], activePath: null, expanded: [], treeWidth: 240, root: null }),
    syncRoot: vi.fn(),
    setTreeWidth: vi.fn(),
  } as unknown as ReturnType<typeof useFileTabs> & { syncRoot: ReturnType<typeof vi.fn> };
}

function renderPanel(fileTabs: ReturnType<typeof makeFileTabs>) {
  return render(
    <TooltipProvider>
      <FilesPanel profile={profile} chatSessionId="s1" maximized={false} fileTabs={fileTabs} onToggleMaximized={vi.fn()} onClose={vi.fn()} onOpenTerminal={vi.fn()} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(listFiles).mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const copy = en.panels.files;

// Testing Library's `findBy` waits on real timers and hangs under vitest's
// fake ones, so each test lets the pending promises settle and then reads.
const settle = () => act(() => vi.advanceTimersByTimeAsync(10));

// The side panel opens without waiting for the session to have a folder, so
// the pane has to say so, and has to notice the folder arriving on its own:
// that arrives on the conversation's socket, which this pane cannot see.
describe("FilesPanel — a session with no folder yet", () => {
  it("says there is no folder instead of loading forever", async () => {
    vi.mocked(listFiles).mockRejectedValue(new Error("invalid_path"));
    renderPanel(makeFileTabs());

    await settle();

    expect(screen.getByText(copy.noFolder)).toBeInTheDocument();
    expect(screen.queryByText(copy.loading)).not.toBeInTheDocument();
  });

  it("keeps asking and takes the root the moment there is one", async () => {
    const fileTabs = makeFileTabs();
    vi.mocked(listFiles)
      .mockRejectedValueOnce(new Error("invalid_path"))
      .mockRejectedValueOnce(new Error("invalid_path"))
      .mockResolvedValue({ root: "/home/user/project", path: "/home/user/project", entries: [] });
    renderPanel(fileTabs);
    await settle();
    expect(screen.getByText(copy.noFolder)).toBeInTheDocument();
    expect(fileTabs.syncRoot).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(fileTabs.syncRoot).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1500));

    expect(fileTabs.syncRoot).toHaveBeenCalledWith("s1", "/home/user/project");
    expect(vi.mocked(listFiles)).toHaveBeenCalledTimes(3);
  });

  it("stops asking once the panel is gone", async () => {
    vi.mocked(listFiles).mockRejectedValue(new Error("invalid_path"));
    const { unmount } = renderPanel(makeFileTabs());
    await settle();
    unmount();

    const calls = vi.mocked(listFiles).mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(vi.mocked(listFiles)).toHaveBeenCalledTimes(calls);
  });

  // The relay not answering is not the same thing as the session having no
  // folder, and must not read as it.
  it("keeps saying it is loading when the relay cannot be reached", async () => {
    vi.mocked(listFiles).mockRejectedValue(new TypeError("Failed to fetch"));
    renderPanel(makeFileTabs());
    await settle();

    expect(screen.getByText(copy.loading)).toBeInTheDocument();
    expect(screen.queryByText(copy.noFolder)).not.toBeInTheDocument();
  });
});
