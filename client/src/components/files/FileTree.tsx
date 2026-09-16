import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, Code2, Download, FilePlus, Pencil, SquareTerminal, Trash2 } from "lucide-react";
import type { ChangeSignal } from "@/components/files/FilesPanel";
import { CreateFileDialog } from "@/components/files/CreateFileDialog";
import { RenameFileDialog } from "@/components/files/RenameFileDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { ContextMenuAnchor, useContextMenu } from "@/hooks/useContextMenu";
import { detectEditors, type DetectedEditor } from "@/lib/editors";
import { buildEditorUrl, type EditorId, type EditorLocality } from "@/lib/editorLinks";
import { finishBatchDownload, notifyFileDownloaded, startBatchDownload, tickBatchDownload } from "@/lib/downloadNotifications";
import { downloadFile, downloadFolder, PartialFolderDownloadError } from "@/lib/fileDownload";
import { createFile, deleteFile, getHostInfo, listFiles, renameFile, type FileEntry } from "@/lib/filesClient";
import { isIOS } from "@/lib/platform";
import type { Profile } from "@/lib/profiles";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";

type DirState = FileEntry[] | "loading" | "error";

interface FileTreeProps {
  profile: Profile;
  sessionId: string;
  root: string;
  expanded: string[];
  activePath: string | null;
  showHidden: boolean;
  /** Watch reported a change in this directory — the
   * folder's cache entry is dropped so the "load whatever's visible but
   * missing" effect below picks it back up. */
  changedDir: ChangeSignal | null;
  onToggleExpand: (path: string) => void;
  onOpenPreview: (path: string) => void;
  onOpenPinned: (path: string) => void;
  /** A tab open on the deleted/renamed path needs to close (delete) or
   * follow the new path (rename) — the tree's own listing self-corrects via
   * the watch without any of this, but tab state lives in
   * `useFileTabs`, one level up in `FilesPanel`. */
  onFileDeleted: (path: string) => void;
  onFileRenamed: (oldPath: string, newPath: string) => void;
  /** Opens (or reuses, per `useSessionDock.openPane`) the terminal pane with
   * a fresh tab rooted at this folder — wired all the way up to `App.tsx`,
   * the only place that has both the terminal tabs and the dock state. */
  onOpenTerminal: (path: string) => void;
  /** Folder row a drag-and-drop upload is currently hovering, or `null` for
   * "none"/"root" — drives the highlight below and, via each row's
   * `data-file-tree-dir`, is how `FilesPanel` resolves which folder a drop
   * lands in (`elementFromPoint` + `closest`). Owned by `FilesPanel` since
   * the Tauri drag events it reads are window-global, not scoped to this
   * component. */
  dropTargetPath: string | null;
}

const INDENT_PX = 14;

/** Depth-first, pre-order list of files (dirs skipped, per the SHIFT-range
 * decision below) in the exact order `FileTreeChildren`/`FileTreeNode`
 * render them — the only way to compute "everything between the anchor and
 * the SHIFT-clicked row" without duplicating the render's own tree walk. A
 * collapsed folder's contents are invisible, so they never enter the range. */
function flattenVisibleFiles(dir: string, nodesByDir: Record<string, DirState>, expanded: string[]): FileEntry[] {
  const nodes = nodesByDir[dir];
  if (!Array.isArray(nodes)) return [];
  const result: FileEntry[] = [];
  for (const entry of nodes) {
    if (entry.kind === "file") result.push(entry);
    else if (expanded.includes(entry.path)) result.push(...flattenVisibleFiles(entry.path, nodesByDir, expanded));
  }
  return result;
}

interface EditorOpenMenuItemsProps {
  editors: DetectedEditor[];
  locality: EditorLocality;
  path: string;
  /** Built by the caller from the dictionary — "Open in {editor}" for a
   * file/folder row, "Open the project in {editor}" for the panel-level
   * root action. */
  itemLabel: (editorLabel: string) => string;
  /** Submenu trigger label used only when more than one editor was
   * detected — "Open with" / "Open the project with". */
  subTriggerLabel: string;
  onSelected: () => void;
}

/**
 * "Open in editor" — hidden entirely when there's no declared
 * locality (both `ANYWH_EDITOR_LOCAL`/`ANYWH_EDITOR_SSH` unset
 * relay-side), no detected editor, or on iOS (no deep link handler exists
 * there). One editor renders a plain item; more than one nests under an
 * "Open with" submenu, mirroring the file/folder row's existing pattern of
 * plain item vs. nested choice.
 */
function EditorOpenMenuItems({ editors, locality, path, itemLabel, subTriggerLabel, onSelected }: EditorOpenMenuItemsProps) {
  if (isIOS() || !locality || editors.length === 0) return null;

  function openInEditor(editorId: EditorId): void {
    onSelected();
    const url = buildEditorUrl(editorId, locality, { path });
    if (url) void openUrl(url);
  }

  if (editors.length === 1) {
    const editor = editors[0];
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            openInEditor(editor.id);
          }}
        >
          <Code2 />
          {itemLabel(editor.label)}
        </DropdownMenuItem>
      </>
    );
  }

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Code2 />
          {subTriggerLabel}
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent>
            {editors.map((editor) => (
              <DropdownMenuItem
                key={editor.id}
                onSelect={(event) => {
                  event.preventDefault();
                  openInEditor(editor.id);
                }}
              >
                {editor.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
    </>
  );
}

/**
 * Lazy tree — only ever lists one folder at a time (a recursive
 * scan doesn't scale once `node_modules` is in the picture), caching each
 * expanded folder's listing locally. `root`/`showHidden` changing means the
 * whole cache is stale (a different cwd, or dotfiles toggling visibility),
 * so both reset it; an already-cached or in-flight folder is never
 * refetched (`inFlightRef` guards against StrictMode's dev double-effect and
 * against re-running the "load whatever's expanded but missing" effect on
 * every state update).
 */
export function FileTree({
  profile,
  sessionId,
  root,
  expanded,
  activePath,
  showHidden,
  changedDir,
  onToggleExpand,
  onOpenPreview,
  onOpenPinned,
  onFileDeleted,
  onFileRenamed,
  onOpenTerminal,
  dropTargetPath,
}: FileTreeProps) {
  const dict = useDict();
  const copy = dict.panels.files.tree;
  const [nodesByDir, setNodesByDir] = useState<Record<string, DirState>>({});
  const inFlightRef = useRef<Set<string>>(new Set());
  const panelMenu = useContextMenu();
  const [createOpen, setCreateOpen] = useState(false);
  const [editorLocality, setEditorLocality] = useState<EditorLocality>(null);
  const [detectedEditors, setDetectedEditors] = useState<DetectedEditor[]>([]);

  // SHIFT range-select (files only). `anchorPath` is the last *plain* click,
  // never moved by a SHIFT-click, so repeated SHIFT-clicks keep extending the
  // same range instead of walking it. Kept in sync with `activePath` below so
  // navigating away (a tab click, "open in new tab", ...) collapses back to a
  // single selection instead of leaving a stale multi-select behind.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);

  useEffect(() => {
    setAnchorPath(activePath);
    setSelectedPaths(activePath ? new Set([activePath]) : new Set());
  }, [activePath]);

  const visibleFiles = useMemo(() => flattenVisibleFiles(root, nodesByDir, expanded), [root, nodesByDir, expanded]);

  // Every cached file entry regardless of current expand state — a SHIFT
  // range can include a file whose parent folder gets collapsed afterwards,
  // and bulk download still needs its `name`/`mtimeMs` at that point.
  const allEntriesByPath = useMemo(() => {
    const map = new Map<string, FileEntry>();
    for (const nodes of Object.values(nodesByDir)) {
      if (Array.isArray(nodes)) for (const entry of nodes) map.set(entry.path, entry);
    }
    return map;
  }, [nodesByDir]);

  const handleFileClick = useCallback(
    (path: string, shiftKey: boolean) => {
      if (shiftKey && anchorPath) {
        const anchorIndex = visibleFiles.findIndex((entry) => entry.path === anchorPath);
        const targetIndex = visibleFiles.findIndex((entry) => entry.path === path);
        if (anchorIndex !== -1 && targetIndex !== -1) {
          const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
          setSelectedPaths(new Set(visibleFiles.slice(start, end + 1).map((entry) => entry.path)));
          return;
        }
      }
      onOpenPreview(path);
    },
    [anchorPath, visibleFiles, onOpenPreview],
  );

  async function handleBulkDelete(paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        await deleteFile(profile, sessionId, path);
        onFileDeleted(path);
      } catch (error) {
        console.error("[anywh] failed to delete file:", path, error);
        window.alert(copy.errors.delete);
      }
    }
    setSelectedPaths(new Set());
  }

  async function handleBulkDownload(paths: string[]): Promise<void> {
    const jobId = startBatchDownload(paths.length);
    for (const [index, path] of paths.entries()) {
      const entry = allEntriesByPath.get(path);
      if (entry) {
        try {
          await downloadFile(profile, sessionId, entry.path, entry.name, entry.mtimeMs);
        } catch (error) {
          console.error("[anywh] failed to download file:", path, error);
          window.alert(copy.errors.download);
        }
      }
      tickBatchDownload(jobId, index + 1);
    }
    finishBatchDownload(jobId);
  }

  // "Open in editor": locality comes from the relay (declared,
  // never inferred — see editorHostInfo.ts), the editor list from a local
  // OS-level scheme detection (editors.rs) — independent lookups, so
  // neither needs to wait on the other before hiding/showing the feature.
  useEffect(() => {
    let cancelled = false;
    getHostInfo(profile)
      .then((info) => {
        if (!cancelled) setEditorLocality(info.editor);
      })
      .catch(() => {});
    detectEditors().then((editors) => {
      if (!cancelled) setDetectedEditors(editors);
    });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  async function handleCreateFile(name: string): Promise<void> {
    try {
      const result = await createFile(profile, sessionId, name);
      setCreateOpen(false);
      onOpenPinned(result.path);
    } catch (error) {
      console.error("[anywh] failed to create file:", error);
      window.alert(copy.errors.create);
    }
  }

  const loadDir = useCallback(
    (dir: string) => {
      if (inFlightRef.current.has(dir)) return;
      inFlightRef.current.add(dir);
      setNodesByDir((prev) => ({ ...prev, [dir]: "loading" }));
      listFiles(profile, sessionId, dir === root ? undefined : dir, showHidden)
        .then((result) => setNodesByDir((prev) => ({ ...prev, [dir]: result.entries })))
        .catch(() => setNodesByDir((prev) => ({ ...prev, [dir]: "error" })))
        .finally(() => inFlightRef.current.delete(dir));
    },
    [profile, sessionId, root, showHidden],
  );

  useEffect(() => {
    setNodesByDir({});
    inFlightRef.current.clear();
    loadDir(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, showHidden]);

  // The root's own children render unconditionally (see the JSX below), so
  // it's always "visible" for this purpose even though it's never itself an
  // entry in `expanded`.
  useEffect(() => {
    for (const dir of [root, ...expanded]) {
      if (!(dir in nodesByDir)) loadDir(dir);
    }
  }, [root, expanded, nodesByDir, loadDir]);

  // Watch — drop the changed folder's cache entry so the
  // effect above (which only fetches what's MISSING from the cache) picks it
  // back up. A no-op for a directory that isn't currently visible: deleting
  // an absent key changes nothing, and the effect above only reloads
  // `[root, ...expanded]`.
  useEffect(() => {
    if (!changedDir) return;
    setNodesByDir((prev) => {
      if (!(changedDir.path in prev)) return prev;
      const next = { ...prev };
      delete next[changedDir.path];
      return next;
    });
  }, [changedDir]);

  return (
    <div className="scrollbar-thin h-full overflow-auto bg-bg-chrome py-1 text-xs" onContextMenu={panelMenu.onContextMenu}>
      <FileTreeChildren
        dir={root}
        depth={0}
        profile={profile}
        sessionId={sessionId}
        nodesByDir={nodesByDir}
        expanded={expanded}
        activePath={activePath}
        onToggleExpand={onToggleExpand}
        onOpenPinned={onOpenPinned}
        onFileDeleted={onFileDeleted}
        onFileRenamed={onFileRenamed}
        onOpenTerminal={onOpenTerminal}
        editorLocality={editorLocality}
        detectedEditors={detectedEditors}
        dropTargetPath={dropTargetPath}
        selectedPaths={selectedPaths}
        onFileClick={handleFileClick}
        onBulkDelete={(paths) => void handleBulkDelete(paths)}
        onBulkDownload={(paths) => void handleBulkDownload(paths)}
      />
      <DropdownMenu open={panelMenu.open} onOpenChange={panelMenu.setOpen}>
        <ContextMenuAnchor position={panelMenu.position} />
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              panelMenu.setOpen(false);
              setCreateOpen(true);
            }}
          >
            <FilePlus />
            {copy.newFile.title}
          </DropdownMenuItem>
          <EditorOpenMenuItems
            editors={detectedEditors}
            locality={editorLocality}
            path={root}
            itemLabel={(label) => copy.openProjectIn.replace("{editor}", label)}
            subTriggerLabel={copy.openProjectWith}
            onSelected={() => panelMenu.setOpen(false)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateFileDialog open={createOpen} onOpenChange={setCreateOpen} onSave={(name) => void handleCreateFile(name)} />
    </div>
  );
}

interface SharedTreeProps {
  depth: number;
  profile: Profile;
  sessionId: string;
  nodesByDir: Record<string, DirState>;
  expanded: string[];
  activePath: string | null;
  onToggleExpand: (path: string) => void;
  onOpenPinned: (path: string) => void;
  onFileDeleted: (path: string) => void;
  onFileRenamed: (oldPath: string, newPath: string) => void;
  onOpenTerminal: (path: string) => void;
  editorLocality: EditorLocality;
  detectedEditors: DetectedEditor[];
  dropTargetPath: string | null;
  /** Multi-select (SHIFT range, files only) — owned by `FileTree` since a
   * range spans nodes from possibly-different `FileTreeChildren` subtrees. */
  selectedPaths: Set<string>;
  onFileClick: (path: string, shiftKey: boolean) => void;
  onBulkDelete: (paths: string[]) => void;
  onBulkDownload: (paths: string[]) => void;
}

interface ChildrenProps extends SharedTreeProps {
  dir: string;
}

function FileTreeChildren({
  dir,
  depth,
  profile,
  sessionId,
  nodesByDir,
  expanded,
  activePath,
  onToggleExpand,
  onOpenPinned,
  onFileDeleted,
  onFileRenamed,
  onOpenTerminal,
  editorLocality,
  detectedEditors,
  dropTargetPath,
  selectedPaths,
  onFileClick,
  onBulkDelete,
  onBulkDownload,
}: ChildrenProps) {
  const dict = useDict();
  const copy = dict.panels.files;
  const nodes = nodesByDir[dir];
  const indent = `${depth * INDENT_PX + 8}px`;

  if (nodes === undefined || nodes === "loading") {
    return (
      <div style={{ paddingLeft: indent }} className="py-1 text-text-faint">
        {copy.loading}
      </div>
    );
  }
  if (nodes === "error") {
    return (
      <div style={{ paddingLeft: indent }} className="py-1 text-destructive">
        {copy.tree.listFailed}
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <div style={{ paddingLeft: indent }} className="py-1 text-text-faint italic">
        {copy.tree.emptyFolder}
      </div>
    );
  }

  return (
    <>
      {nodes.map((entry) => (
        <FileTreeNode
          key={entry.path}
          entry={entry}
          depth={depth}
          profile={profile}
          sessionId={sessionId}
          nodesByDir={nodesByDir}
          expanded={expanded}
          activePath={activePath}
          onToggleExpand={onToggleExpand}
          onOpenPinned={onOpenPinned}
          onFileDeleted={onFileDeleted}
          onFileRenamed={onFileRenamed}
          onOpenTerminal={onOpenTerminal}
          editorLocality={editorLocality}
          detectedEditors={detectedEditors}
          dropTargetPath={dropTargetPath}
          selectedPaths={selectedPaths}
          onFileClick={onFileClick}
          onBulkDelete={onBulkDelete}
          onBulkDownload={onBulkDownload}
        />
      ))}
    </>
  );
}

interface NodeProps extends SharedTreeProps {
  entry: FileEntry;
}

function FileTreeNode({
  entry,
  depth,
  profile,
  sessionId,
  nodesByDir,
  expanded,
  activePath,
  onToggleExpand,
  onOpenPinned,
  onFileDeleted,
  onFileRenamed,
  onOpenTerminal,
  editorLocality,
  detectedEditors,
  dropTargetPath,
  selectedPaths,
  onFileClick,
  onBulkDelete,
  onBulkDownload,
}: NodeProps) {
  const dict = useDict();
  const copy = dict.panels.files.tree;
  const isDir = entry.kind === "dir";
  const isExpanded = isDir && expanded.includes(entry.path);
  const isActive = entry.path === activePath;
  // A row is part of the "batch" menu/highlight only once 2+ files are
  // selected and this one is among them — a lone selected file (the common
  // case) keeps the regular single-file menu and `isActive`'s highlight.
  const isMultiSelected = !isDir && selectedPaths.size > 1 && selectedPaths.has(entry.path);
  // File and directory rows show different items below — both get a menu now, "open in terminal" only makes
  // sense for a folder.
  const menu = useContextMenu();
  const [renameOpen, setRenameOpen] = useState(false);

  async function handleDownload(): Promise<void> {
    try {
      if (await downloadFile(profile, sessionId, entry.path, entry.name, entry.mtimeMs)) notifyFileDownloaded(entry.name);
    } catch (error) {
      console.error("[anywh] failed to download file:", error);
      window.alert(copy.errors.download);
    }
  }

  async function handleRename(newName: string): Promise<void> {
    try {
      const result = await renameFile(profile, sessionId, entry.path, newName);
      onFileRenamed(entry.path, result.path);
      setRenameOpen(false);
    } catch (error) {
      console.error("[anywh] failed to rename file:", error);
      window.alert(copy.errors.rename);
    }
  }

  async function handleDelete(): Promise<void> {
    try {
      await deleteFile(profile, sessionId, entry.path);
      onFileDeleted(entry.path);
    } catch (error) {
      console.error("[anywh] failed to delete file:", error);
      window.alert(copy.errors.delete);
    }
  }

  async function confirmDelete(): Promise<void> {
    const confirmed = await confirmDialog(copy.deleteFile.description.replace("{name}", entry.name), {
      title: copy.deleteFile.title,
      kind: "warning",
      okLabel: dict.common.delete,
      cancelLabel: dict.common.cancel,
    });
    if (confirmed) await handleDelete();
  }

  async function confirmBulkDelete(): Promise<void> {
    const confirmed = await confirmDialog(copy.deleteFiles.description.replace("{count}", String(selectedPaths.size)), {
      title: copy.deleteFiles.title,
      kind: "warning",
      okLabel: dict.common.delete,
      cancelLabel: dict.common.cancel,
    });
    if (confirmed) onBulkDelete(Array.from(selectedPaths));
  }

  async function handleDownloadFolder(): Promise<void> {
    let jobId: string | null = null;
    try {
      await downloadFolder(profile, sessionId, entry.path, entry.name, (completed, total) => {
        jobId ??= startBatchDownload(total);
        tickBatchDownload(jobId, completed);
      });
    } catch (error) {
      console.error("[anywh] failed to download folder:", error);
      window.alert(
        error instanceof PartialFolderDownloadError
          ? copy.errors.downloadFolderPartial
              .replace("{failed}", String(error.failed))
              .replace("{total}", String(error.total))
          : copy.errors.downloadFolder,
      );
    } finally {
      if (jobId !== null) finishBatchDownload(jobId);
    }
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        data-file-tree-dir={isDir ? entry.path : undefined}
        onClick={(event) => {
          // `DropdownMenuContent` portals its DOM node elsewhere (usually
          // `document.body`) but stays a React-tree descendant of this row —
          // React re-dispatches a portaled child's synthetic click up
          // through ancestor handlers by *fiber* tree, regardless of real
          // DOM containment. Left unguarded, clicking any menu item also
          // looks like a plain click on this row and would collapse a
          // multi-selection right as a batch action's menu item is picked.
          if (!event.currentTarget.contains(event.target as Node)) return;
          if (isDir) onToggleExpand(entry.path);
          else onFileClick(entry.path, event.shiftKey);
        }}
        onDoubleClick={() => !isDir && onOpenPinned(entry.path)}
        onMouseDown={(event) => {
          // Otherwise a SHIFT-click also fires the browser's native
          // text-selection drag, highlighting row labels alongside our own
          // (unrelated) multi-select.
          if (event.shiftKey) event.preventDefault();
        }}
        onContextMenu={(event) => {
          // Right-clicking a file outside the current selection replaces it
          // (mirrors a plain click) — only a file already part of a 2+
          // selection keeps that selection and gets the batch menu below.
          if (!isDir && !isMultiSelected) onFileClick(entry.path, false);
          menu.onContextMenu(event);
        }}
        onKeyDown={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          if (isDir) onToggleExpand(entry.path);
          else onFileClick(entry.path, false);
        }}
        style={{ paddingLeft: `${depth * INDENT_PX + 8}px` }}
        className={cn(
          // Kind is read from weight, not from an icon: an open folder is the
          // brightest thing on the row, a closed one a step down, a file a
          // step below that. The caret alone marks what can be expanded —
          // which also spares a node per row on a tree that routinely has
          // hundreds.
          "flex cursor-pointer items-center gap-1.5 py-0.5 pr-2 transition-colors hover:bg-surface-hover",
          isActive
            ? "bg-primary-soft text-primary-ink"
            : isMultiSelected
              ? "bg-primary-soft/60 text-foreground"
              : isDir
                ? isExpanded
                  ? "text-foreground"
                  : "text-muted-foreground"
                : "text-text-faint",
          isDir && dropTargetPath === entry.path && "bg-primary-soft text-primary-ink outline outline-primary -outline-offset-1",
        )}
      >
        {isDir ? (
          isExpanded ? (
            <ChevronDown className="size-3 shrink-0 text-text-faint" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-text-faint" />
          )
        ) : (
          <span className="size-3 shrink-0" />
        )}
        <span className="truncate">{entry.name}</span>
        {!isDir && (
          <DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
            <ContextMenuAnchor position={menu.position} />
            <DropdownMenuContent align="start">
              {isMultiSelected ? (
                <>
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      menu.setOpen(false);
                      onBulkDownload(Array.from(selectedPaths));
                    }}
                  >
                    <Download />
                    {copy.downloadMany.replace("{count}", String(selectedPaths.size))}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={(event) => {
                      event.preventDefault();
                      menu.setOpen(false);
                      void confirmBulkDelete();
                    }}
                  >
                    <Trash2 />
                    {copy.deleteMany.replace("{count}", String(selectedPaths.size))}
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      menu.setOpen(false);
                      onOpenPinned(entry.path);
                    }}
                  >
                    {copy.openInNewTab}
                  </DropdownMenuItem>
                  <EditorOpenMenuItems
                    editors={detectedEditors}
                    locality={editorLocality}
                    path={entry.path}
                    itemLabel={(label) => copy.openIn.replace("{editor}", label)}
                    subTriggerLabel={copy.openWith}
                    onSelected={() => menu.setOpen(false)}
                  />
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      menu.setOpen(false);
                      void handleDownload();
                    }}
                  >
                    <Download />
                    {copy.download}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      menu.setOpen(false);
                      setRenameOpen(true);
                    }}
                  >
                    <Pencil />
                    {copy.rename}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={(event) => {
                      event.preventDefault();
                      menu.setOpen(false);
                      void confirmDelete();
                    }}
                  >
                    <Trash2 />
                    {copy.delete}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {isDir && (
          <DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
            <ContextMenuAnchor position={menu.position} />
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  menu.setOpen(false);
                  onOpenTerminal(entry.path);
                }}
              >
                <SquareTerminal />
                {copy.openInTerminal}
              </DropdownMenuItem>
              <EditorOpenMenuItems
                editors={detectedEditors}
                locality={editorLocality}
                path={entry.path}
                itemLabel={(label) => copy.openIn.replace("{editor}", label)}
                subTriggerLabel={copy.openWith}
                onSelected={() => menu.setOpen(false)}
              />
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  menu.setOpen(false);
                  void handleDownloadFolder();
                }}
              >
                <Download />
                {copy.download}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {!isDir && (
        <RenameFileDialog open={renameOpen} onOpenChange={setRenameOpen} initialName={entry.name} onSave={(name) => void handleRename(name)} />
      )}
      {isDir && isExpanded && (
        <FileTreeChildren
          dir={entry.path}
          depth={depth + 1}
          profile={profile}
          sessionId={sessionId}
          nodesByDir={nodesByDir}
          expanded={expanded}
          activePath={activePath}
          onToggleExpand={onToggleExpand}
          onOpenPinned={onOpenPinned}
          onFileDeleted={onFileDeleted}
          onFileRenamed={onFileRenamed}
          onOpenTerminal={onOpenTerminal}
          editorLocality={editorLocality}
          detectedEditors={detectedEditors}
          dropTargetPath={dropTargetPath}
          selectedPaths={selectedPaths}
          onFileClick={onFileClick}
          onBulkDelete={onBulkDelete}
          onBulkDownload={onBulkDownload}
        />
      )}
    </div>
  );
}
