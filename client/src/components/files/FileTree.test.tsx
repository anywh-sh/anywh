import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileTree } from "./FileTree";
import { en } from "@/i18n/en";
import type { Profile } from "@/lib/profiles/profiles";
import type { FilesListResult } from "@/lib/relay/filesClient";

vi.mock("@/lib/relay/filesClient", () => ({
  listFiles: vi.fn(),
  createFile: vi.fn(),
  deleteFile: vi.fn(),
  renameFile: vi.fn(),
  getHostInfo: vi.fn(),
}));
vi.mock("@/lib/relay/fileDownload", () => ({
  downloadFile: vi.fn(),
  downloadFolder: vi.fn(),
}));
vi.mock("@/lib/platform/editors", () => ({
  detectEditors: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
}));

import { createFile, deleteFile, getHostInfo, listFiles, renameFile } from "@/lib/relay/filesClient";
import { downloadFile, downloadFolder } from "@/lib/relay/fileDownload";
import { detectEditors } from "@/lib/platform/editors";
import { openUrl } from "@tauri-apps/plugin-opener";
import { confirm } from "@tauri-apps/plugin-dialog";

const profile: Profile = { id: "p1", label: "Perfil", host: "localhost", relayPort: 4317 };
const root = "/home/user/project";

function listing(): FilesListResult {
  return {
    root,
    path: root,
    entries: [
      { name: "src", path: `${root}/src`, kind: "dir", size: 0, mtimeMs: 900 },
      { name: "notas.txt", path: `${root}/notas.txt`, kind: "file", size: 12, mtimeMs: 1000 },
    ],
  };
}

beforeEach(() => {
  vi.mocked(listFiles).mockResolvedValue(listing());
  // Default (both `ANYWH_EDITOR_LOCAL`/`ANYWH_EDITOR_SSH` unset relay-side,
  // and no editor detected) hides the "open in editor" feature entirely —
  // matches editorHostInfo.ts's documented default, so the pre-existing
  // menu tests below don't need to know this feature exists at all.
  vi.mocked(getHostInfo).mockResolvedValue({ hostname: "host", platform: "linux", editor: null });
  vi.mocked(detectEditors).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderTree(
  overrides: {
    onFileDeleted?: (path: string) => void;
    onFileRenamed?: (oldPath: string, newPath: string) => void;
    onOpenTerminal?: (path: string) => void;
    onOpenPinned?: (path: string) => void;
  } = {},
) {
  return render(
    <FileTree
      profile={profile}
      sessionId="session-1"
      root={root}
      expanded={[]}
      activePath={null}
      showHidden={false}
      changedDir={null}
      onToggleExpand={() => {}}
      onOpenPreview={() => {}}
      onOpenPinned={overrides.onOpenPinned ?? (() => {})}
      onFileDeleted={overrides.onFileDeleted ?? (() => {})}
      onFileRenamed={overrides.onFileRenamed ?? (() => {})}
      onOpenTerminal={overrides.onOpenTerminal ?? (() => {})}
      dropTargetPath={null}
    />,
  );
}

describe("FileTree context menu", () => {
  it("shows download/rename/delete on right-click and downloads on the first", async () => {
    const user = userEvent.setup();
    renderTree();
    const row = await screen.findByText("notas.txt");

    await user.pointer({ keys: "[MouseRight]", target: row });
    expect(await screen.findByText(en.panels.files.tree.download)).toBeInTheDocument();
    expect(screen.getByText(en.panels.files.tree.rename)).toBeInTheDocument();
    expect(screen.getByText(en.panels.files.tree.delete)).toBeInTheDocument();

    await user.click(screen.getByText(en.panels.files.tree.download));
    expect(downloadFile).toHaveBeenCalledWith(profile, "session-1", `${root}/notas.txt`, "notas.txt", 1000);
  });

  it("renames the file and reports the new path to the caller", async () => {
    vi.mocked(renameFile).mockResolvedValue({ path: `${root}/renomeado.txt` });
    const onFileRenamed = vi.fn();
    const user = userEvent.setup();
    renderTree({ onFileRenamed });
    const row = await screen.findByText("notas.txt");

    await user.pointer({ keys: "[MouseRight]", target: row });
    await user.click(await screen.findByText(en.panels.files.tree.rename));

    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByDisplayValue("notas.txt");
    await user.clear(input);
    await user.type(input, "renomeado.txt");
    await user.click(within(dialog).getByRole("button", { name: en.common.rename }));

    await waitFor(() => expect(renameFile).toHaveBeenCalledWith(profile, "session-1", `${root}/notas.txt`, "renomeado.txt"));
    expect(onFileRenamed).toHaveBeenCalledWith(`${root}/notas.txt`, `${root}/renomeado.txt`);
  });

  it("deletes the file only after confirming, and reports it to the caller", async () => {
    vi.mocked(deleteFile).mockResolvedValue(undefined);
    const onFileDeleted = vi.fn();
    const user = userEvent.setup();
    renderTree({ onFileDeleted });
    const row = await screen.findByText("notas.txt");

    // The native OS confirm dialog isn't real DOM here — gate the outcome
    // through the mock instead of an in-page `alertdialog` role.
    vi.mocked(confirm).mockResolvedValue(false);
    await user.pointer({ keys: "[MouseRight]", target: row });
    await user.click(await screen.findByText(en.panels.files.tree.delete));

    await waitFor(() => expect(confirm).toHaveBeenCalledWith(en.panels.files.tree.deleteFile.description.replace("{name}", "notas.txt"), expect.objectContaining({ title: en.panels.files.tree.deleteFile.title })));
    expect(deleteFile).not.toHaveBeenCalled();

    vi.mocked(confirm).mockResolvedValue(true);
    await user.pointer({ keys: "[MouseRight]", target: row });
    await user.click(await screen.findByText(en.panels.files.tree.delete));

    await waitFor(() => expect(deleteFile).toHaveBeenCalledWith(profile, "session-1", `${root}/notas.txt`));
    expect(onFileDeleted).toHaveBeenCalledWith(`${root}/notas.txt`);
  });

  it("right-clicking a row never also surfaces the panel's own menu", async () => {
    const user = userEvent.setup();
    renderTree();
    const row = await screen.findByText("notas.txt");

    await user.pointer({ keys: "[MouseRight]", target: row });
    expect(await screen.findByText(en.panels.files.tree.download)).toBeInTheDocument();
    expect(screen.queryByText(en.panels.files.tree.newFile.title)).toBeNull();
  });

  it("creates a new file from the panel's background menu and opens it", async () => {
    vi.mocked(createFile).mockResolvedValue({ path: `${root}/criado.txt` });
    const onOpenPinned = vi.fn();
    const user = userEvent.setup();
    const { container } = renderTree({ onOpenPinned });
    await screen.findByText("notas.txt");

    // The tree's own scroll container, not a specific row — the empty
    // background is what the panel-level menu listens on.
    const panel = container.firstElementChild as HTMLElement;
    await user.pointer({ keys: "[MouseRight]", target: panel });
    await user.click(await screen.findByText(en.panels.files.tree.newFile.title));

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText(en.panels.files.tree.newFile.placeholder), "criado.txt");
    await user.click(within(dialog).getByRole("button", { name: en.common.create }));

    await waitFor(() => expect(createFile).toHaveBeenCalledWith(profile, "session-1", "criado.txt"));
    expect(onOpenPinned).toHaveBeenCalledWith(`${root}/criado.txt`);
  });

  it("shows open-in-terminal on right-click of a folder, and reports its path", async () => {
    const onOpenTerminal = vi.fn();
    const user = userEvent.setup();
    renderTree({ onOpenTerminal });
    const row = await screen.findByText("src");

    await user.pointer({ keys: "[MouseRight]", target: row });
    expect(screen.queryByText(en.panels.files.tree.rename)).toBeNull();
    expect(screen.queryByText(en.panels.files.tree.delete)).toBeNull();
    await user.click(await screen.findByText(en.panels.files.tree.openInTerminal));

    expect(onOpenTerminal).toHaveBeenCalledWith(`${root}/src`);
  });

  it("downloads a folder from its context menu", async () => {
    const user = userEvent.setup();
    renderTree();
    const row = await screen.findByText("src");

    await user.pointer({ keys: "[MouseRight]", target: row });
    await user.click(await screen.findByText(en.panels.files.tree.download));

    expect(downloadFolder).toHaveBeenCalledWith(profile, "session-1", `${root}/src`, "src", expect.any(Function));
  });
});

describe("FileTree multi-select (SHIFT range)", () => {
  function multiListing(): FilesListResult {
    return {
      root,
      path: root,
      entries: [
        { name: "a.txt", path: `${root}/a.txt`, kind: "file", size: 1, mtimeMs: 100 },
        { name: "b.txt", path: `${root}/b.txt`, kind: "file", size: 1, mtimeMs: 200 },
        { name: "c.txt", path: `${root}/c.txt`, kind: "file", size: 1, mtimeMs: 300 },
      ],
    };
  }

  // `activePath` has to be real state here, not a fixed prop like the other
  // tests' `renderTree` uses — the selection sync effect (FileTree.tsx)
  // reacts to `activePath` *changing*, mirroring how `FilesPanel` actually
  // feeds it back in from `useFileTabs` after `onOpenPreview`.
  function ControlledFileTree({ onFileDeleted = () => {} }: { onFileDeleted?: (path: string) => void }) {
    const [activePath, setActivePath] = useState<string | null>(null);
    return (
      <FileTree
        profile={profile}
        sessionId="session-1"
        root={root}
        expanded={[]}
        activePath={activePath}
        showHidden={false}
        changedDir={null}
        onToggleExpand={() => {}}
        onOpenPreview={setActivePath}
        onOpenPinned={() => {}}
        onFileDeleted={onFileDeleted}
        onFileRenamed={() => {}}
        onOpenTerminal={() => {}}
        dropTargetPath={null}
      />
    );
  }

  it("SHIFT-clicking a file extends the selection to the range and offers batch actions for it", async () => {
    vi.mocked(listFiles).mockResolvedValue(multiListing());
    vi.mocked(deleteFile).mockResolvedValue(undefined);
    vi.mocked(confirm).mockResolvedValue(true);
    const onFileDeleted = vi.fn();
    const user = userEvent.setup();
    render(<ControlledFileTree onFileDeleted={onFileDeleted} />);

    fireEvent.click(await screen.findByText("a.txt"));
    fireEvent.click(await screen.findByText("c.txt"), { shiftKey: true });

    // Right-clicking the row in between (never itself clicked) still counts
    // as part of the range and surfaces the batch menu, not the single-file one.
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("b.txt") });
    expect(await screen.findByText(en.panels.files.tree.downloadMany.replace("{count}", "3"))).toBeInTheDocument();
    const deleteItem = await screen.findByText(en.panels.files.tree.deleteMany.replace("{count}", "3"));

    await user.click(deleteItem);

    await waitFor(() => expect(deleteFile).toHaveBeenCalledTimes(3));
    expect(onFileDeleted).toHaveBeenCalledWith(`${root}/a.txt`);
    expect(onFileDeleted).toHaveBeenCalledWith(`${root}/b.txt`);
    expect(onFileDeleted).toHaveBeenCalledWith(`${root}/c.txt`);
  });

  it("right-clicking a file outside the current selection replaces it, back to the single-file menu", async () => {
    vi.mocked(listFiles).mockResolvedValue(multiListing());
    const user = userEvent.setup();
    render(<ControlledFileTree />);

    fireEvent.click(await screen.findByText("a.txt"));
    fireEvent.click(await screen.findByText("b.txt"), { shiftKey: true });

    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("c.txt") });
    expect(await screen.findByText(en.panels.files.tree.delete)).toBeInTheDocument();
    expect(screen.queryByText(en.panels.files.tree.deleteMany.replace("{count}", "2"))).toBeNull();
  });
});

describe("FileTree 'open in editor' menu", () => {
  it("hides the feature entirely when the relay declares no editor locality, even if an editor is detected", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({ hostname: "host", platform: "linux", editor: null });
    vi.mocked(detectEditors).mockResolvedValue([{ id: "zed", label: "Zed" }]);
    const user = userEvent.setup();
    renderTree();
    const row = await screen.findByText("notas.txt");

    await user.pointer({ keys: "[MouseRight]", target: row });
    expect(await screen.findByText(en.panels.files.tree.download)).toBeInTheDocument();
    expect(screen.queryByText(/Abrir no/)).toBeNull();
    expect(screen.queryByText(en.panels.files.tree.openWith)).toBeNull();
  });

  it("hides the feature entirely when no editor was detected, even if the relay declares a local editor", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({ hostname: "host", platform: "linux", editor: { kind: "local" } });
    vi.mocked(detectEditors).mockResolvedValue([]);
    const user = userEvent.setup();
    renderTree();
    const row = await screen.findByText("notas.txt");

    await user.pointer({ keys: "[MouseRight]", target: row });
    expect(await screen.findByText(en.panels.files.tree.download)).toBeInTheDocument();
    expect(screen.queryByText(/Abrir no/)).toBeNull();
  });

  it("shows a plain 'Open in <Editor>' item for a file, a folder, and the panel background when exactly one editor is detected, opening the local deep link", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({ hostname: "host", platform: "linux", editor: { kind: "local" } });
    vi.mocked(detectEditors).mockResolvedValue([{ id: "zed", label: "Zed" }]);
    const user = userEvent.setup();
    const { container } = renderTree();

    const fileRow = await screen.findByText("notas.txt");
    await user.pointer({ keys: "[MouseRight]", target: fileRow });
    await user.click(await screen.findByText(en.panels.files.tree.openIn.replace("{editor}", "Zed")));
    expect(openUrl).toHaveBeenCalledWith(`zed://file${root}/notas.txt`);

    const folderRow = await screen.findByText("src");
    await user.pointer({ keys: "[MouseRight]", target: folderRow });
    expect(await screen.findByText(en.panels.files.tree.openInTerminal)).toBeInTheDocument();
    await user.click(await screen.findByText(en.panels.files.tree.openIn.replace("{editor}", "Zed")));
    expect(openUrl).toHaveBeenCalledWith(`zed://file${root}/src`);

    const panel = container.firstElementChild as HTMLElement;
    await user.pointer({ keys: "[MouseRight]", target: panel });
    await user.click(await screen.findByText(en.panels.files.tree.openProjectIn.replace("{editor}", "Zed")));
    expect(openUrl).toHaveBeenCalledWith(`zed://file${root}`);
  });

  it("nests more than one detected editor under an 'Abrir com' submenu, opening the deep link for the one picked", async () => {
    vi.mocked(getHostInfo).mockResolvedValue({
      hostname: "host",
      platform: "linux",
      editor: { kind: "ssh", user: "wil", host: "debian-headless" },
    });
    vi.mocked(detectEditors).mockResolvedValue([
      { id: "zed", label: "Zed" },
      { id: "vscode", label: "VS Code" },
    ]);
    const user = userEvent.setup();
    renderTree();
    const row = await screen.findByText("notas.txt");

    await user.pointer({ keys: "[MouseRight]", target: row });
    expect(screen.queryByText(en.panels.files.tree.openIn.replace("{editor}", "Zed"))).toBeNull();
    // Radix's `DropdownMenuSub` opens on hover, not click — a plain click on
    // the trigger toggles the top-level menu closed instead.
    await user.hover(await screen.findByText(en.panels.files.tree.openWith));
    const vsCodeItem = await within(document.body).findByText("VS Code");
    // `userEvent.click` gives up on this element: happy-dom has no real
    // layout engine, so its "is this element actually the topmost hit at
    // its coordinates" check (which real pointer-events rely on) can't
    // resolve for content rendered through a Sub's nested Portal. A plain
    // DOM `click` dispatch is what Radix's item selection actually listens
    // for, so this reaches the same handler a real click would.
    fireEvent.click(vsCodeItem);

    expect(openUrl).toHaveBeenCalledWith(`vscode://vscode-remote/ssh-remote+wil@debian-headless${root}/notas.txt`);
  });
});
