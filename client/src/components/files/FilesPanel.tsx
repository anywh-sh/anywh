import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, FolderInput } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { PaneTabStrip } from "@/components/shell/PaneTabStrip";
import { SessionPanel } from "@/components/shell/SessionPanel";
import { FileTree } from "@/components/files/FileTree";
import { FileViewer } from "@/components/files/FileViewer";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDict } from "@/i18n";
import type { useFileTabs } from "@/hooks/tabs/useFileTabs";
import { listFiles, uploadFile } from "@/lib/relay/filesClient";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import { BrokerRevokedError } from "@/lib/profiles/tailnetBroker";
import { markProfileRevoked } from "@/lib/profiles/profileRevocation";
import { physicalPositionToClientPoint } from "@/lib/dragDropPosition";
import type { Profile } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

export interface ChangeSignal {
  path: string;
  token: number;
}

/** Live refresh — sends the client's full currently
 * visible set (expanded tree dirs + open file tabs) to the relay's `/files`
 * watch endpoint, and turns `dir_changed`/`file_changed` notifications into
 * signals `FileTree`/`FileViewer` react to by invalidating just that one
 * path. A basic fixed-delay reconnect (not the exponential backoff
 * `TerminalView` uses) is enough here — losing this connection only means
 * falling back to manual refresh (reopening the folder/file), not a broken
 * feature. */
function useFilesWatch(profile: Profile, sessionId: string, dirs: string[], files: string[]) {
  const [dirChanged, setDirChanged] = useState<ChangeSignal | null>(null);
  const [fileChanged, setFileChanged] = useState<ChangeSignal | null>(null);
  const tokenRef = useRef(0);
  const dirsFilesRef = useRef({ dirs, files });
  dirsFilesRef.current = { dirs, files };
  const sendRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;

    function sendWatchState(ws: WebSocket): void {
      if (ws.readyState !== WebSocket.OPEN) return;
      const { dirs: watchedDirs, files: watchedFiles } = dirsFilesRef.current;
      ws.send(JSON.stringify({ type: "watch", dirs: watchedDirs, files: watchedFiles }));
    }

    // A tailnet connection needs its own fresh, unspent connect token on
    // every new TCP connection — a reconnect
    // after `close` is a brand-new one, so this resolves again on every
    // call instead of reusing whatever `connect()` used the first time.
    function connect(): void {
      if (cancelled) return;
      resolveConnection(profile)
        .then(({ host, port, token }) => {
          if (cancelled) return;
          const params = new URLSearchParams({ session: sessionId });
          if (token) params.set("token", token);
          const ws = new WebSocket(`ws://${host}:${String(port)}/files?${params.toString()}`);
          socket = ws;
          sendRef.current = () => sendWatchState(ws);

          ws.addEventListener("open", () => sendWatchState(ws));
          ws.addEventListener("message", (event) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(event.data as string);
            } catch {
              return;
            }
            if (typeof parsed !== "object" || parsed === null) return;
            const type = (parsed as { type?: unknown }).type;
            const path = (parsed as { path?: unknown }).path;
            if (typeof path !== "string") return;
            tokenRef.current += 1;
            if (type === "dir_changed") setDirChanged({ path, token: tokenRef.current });
            else if (type === "file_changed") setFileChanged({ path, token: tokenRef.current });
          });
          ws.addEventListener("close", () => {
            if (socket !== ws || cancelled) return;
            reconnectTimer = window.setTimeout(connect, 2000);
          });
        })
        .catch((error: unknown) => {
          console.error("[anywh] failed to resolve a connection for the files watch:", error);
          if (cancelled) return;
          // Terminal — this device's connection was deliberately revoked and
          // will never succeed again, unlike every other reason this could
          // fail (network blip, relay down), which are worth retrying.
          if (error instanceof BrokerRevokedError) {
            markProfileRevoked(profile.id);
            return;
          }
          reconnectTimer = window.setTimeout(connect, 2000);
        });
    }
    connect();

    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [profile, sessionId]);

  useEffect(() => {
    sendRef.current();
  }, [dirs, files]);

  return { dirChanged, fileChanged };
}

interface FilesPanelProps {
  profile: Profile;
  chatSessionId: string;
  maximized: boolean;
  fileTabs: ReturnType<typeof useFileTabs>;
  onToggleMaximized: () => void;
  onClose: () => void;
  /** "Open in terminal" on a folder row — owned by `App.tsx`, the only place
   * with both the terminal tabs and the dock state this needs to touch. */
  onOpenTerminal: (path: string) => void;
}

function fileLabel(path: string): string {
  return path.split("/").pop() || path;
}

function breadcrumbSegments(root: string, path: string): string[] {
  const relative = path.startsWith(root) ? path.slice(root.length) : path;
  return relative.split("/").filter(Boolean);
}

/** Drag for the divider between the tree and the viewer, internal to this
 * pane — separate from `usePanelDrag` (the dock column's own resize handle)
 * because the sign is opposite: this handle sits on the tree's *right*
 * edge, so dragging right should *increase* its width, not decrease it. */
function useTreeWidthDrag(width: number, onChange: (width: number) => void) {
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef(false);

  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      draggingRef.current = true;
      setIsDragging(true);

      const startX = event.clientX;
      const startWidth = width;

      function onMove(moveEvent: PointerEvent): void {
        if (!draggingRef.current) return;
        onChange(startWidth + (moveEvent.clientX - startX));
      }
      function onUp(): void {
        draggingRef.current = false;
        setIsDragging(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, onChange],
  );

  return { isDragging, startDrag };
}

/**
 * Drag-and-drop upload — same native Tauri `onDragDropEvent` as
 * `ChatPanel`'s image attach (delivers the dropped file's real path on
 * disk, read via the `read_dropped_file` Rust command), but the target
 * directory depends on *where* inside the panel the drop lands: a folder
 * row in the tree if the cursor is over one (`data-file-tree-dir`, set by
 * `FileTree`), the session's root otherwise (including a drop on the
 * viewer side). The event is window-global (reaches every mounted panel,
 * ChatPanel included — see the comment there), so every `enter`/`over`/`drop`
 * is first checked against this panel's own `containerRef` via
 * `elementFromPoint`, exactly like `ChatPanel` checks against its own.
 */
function useFilesDrop(profile: Profile, sessionId: string, uploadFailed: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  const resolveDropTarget = useCallback((clientX: number, clientY: number): { withinPanel: boolean; dir: string | null } => {
    const container = containerRef.current;
    if (!container) return { withinPanel: false, dir: null };
    const target = document.elementFromPoint(clientX, clientY);
    if (!target || !container.contains(target)) return { withinPanel: false, dir: null };
    const folderRow = target.closest<HTMLElement>("[data-file-tree-dir]");
    return { withinPanel: true, dir: folderRow?.dataset.fileTreeDir ?? null };
  }, []);

  // The effect below is set up once per session, and the copy can change
  // under it (a language switch) — so it reads the current wording through a
  // ref instead of capturing whatever was current at subscribe time.
  const uploadFailedRef = useRef(uploadFailed);
  uploadFailedRef.current = uploadFailed;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    async function uploadDroppedPaths(paths: string[], dir: string | null): Promise<void> {
      for (const path of paths) {
        const name = path.split(/[\\/]/).pop() ?? "";
        try {
          const buffer = await invoke<ArrayBuffer>("read_dropped_file", { path });
          await uploadFile(profile, sessionId, name, buffer, dir ?? undefined);
        } catch (error) {
          console.error("[anywh] failed to upload dropped file:", path, error);
          window.alert(uploadFailedRef.current.replace("{name}", name));
        }
      }
    }

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "leave") {
          setIsDraggingOver(false);
          setDropTargetPath(null);
          return;
        }

        const { x, y } = physicalPositionToClientPoint(event.payload.position);
        const { withinPanel, dir } = resolveDropTarget(x, y);

        if (event.payload.type === "drop") {
          setIsDraggingOver(false);
          setDropTargetPath(null);
          if (withinPanel) void uploadDroppedPaths(event.payload.paths, dir);
          return;
        }

        setIsDraggingOver(withinPanel);
        setDropTargetPath(withinPanel ? dir : null);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [profile, sessionId, resolveDropTarget]);

  return { containerRef, isDraggingOver, dropTargetPath };
}

/**
 * Work dir file panel content, plugged into the generic
 * `SessionPanel` shell — tree on the left, tabs + breadcrumb + viewer on the
 * right. Mirrors `TerminalPanel`'s mount lifecycle: only exists while the
 * chat tab is active and the pane is open (decided by the caller, App.tsx).
 */
export function FilesPanel({ profile, chatSessionId, maximized, fileTabs, onToggleMaximized, onClose, onOpenTerminal }: FilesPanelProps) {
  const dict = useDict();
  const copy = dict.panels.files;
  const { open, activePath, expanded, treeWidth, root } = fileTabs.getTabs(chatSessionId);
  // Not persisted — same as the terminal's tab list, this is view state, not
  // worth surviving a restart. Defaults to filtered.
  const [showHidden, setShowHidden] = useState(false);

  // Learns/confirms the session's real root once per mount — if it drifted
  // from what was persisted, `syncRoot` itself resets everything path-based
  // below (decision 9: only possible before the first turn locks the cwd).
  useEffect(() => {
    let cancelled = false;
    listFiles(profile, chatSessionId)
      .then((result) => {
        if (!cancelled) fileTabs.syncRoot(chatSessionId, result.root);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, chatSessionId]);

  const { isDragging, startDrag } = useTreeWidthDrag(treeWidth, (width) => fileTabs.setTreeWidth(chatSessionId, width));

  const openPaths = useMemo(() => open.map((tab) => tab.path), [open]);
  // The root's children render unconditionally (FileTree) so it's always
  // visible even though it's never itself an entry in `expanded` — the watch
  // needs to cover it too, or changes made directly at the session's cwd
  // (not inside any expanded subfolder) never surface without a full reopen.
  const watchedDirs = useMemo(() => (root ? [root, ...expanded] : expanded), [root, expanded]);
  const { dirChanged, fileChanged } = useFilesWatch(profile, chatSessionId, watchedDirs, openPaths);
  const { containerRef: dropContainerRef, isDraggingOver, dropTargetPath } = useFilesDrop(profile, chatSessionId, copy.drop.failed);

  if (!root) {
    return (
      <SessionPanel
        maximized={maximized}
        onToggleMaximized={onToggleMaximized}
        onClose={onClose}
        headerExtra={<div className="flex h-8 items-center px-2.5 font-mono text-[11px] text-muted-foreground">{copy.title}</div>}
      >
        <div className="flex h-full items-center justify-center font-mono text-[11px] text-muted-foreground">{copy.loading}</div>
      </SessionPanel>
    );
  }

  return (
    <SessionPanel
      maximized={maximized}
      onToggleMaximized={onToggleMaximized}
      onClose={onClose}
      headerExtra={
        <div className="flex min-w-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setShowHidden((current) => !current)}
                aria-label={showHidden ? copy.hideHidden : copy.showHidden}
                className={cn("h-8 shrink-0 border-0 border-r border-border-soft hover:border-0 hover:border-r", showHidden && "text-foreground")}
              >
                {showHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{showHidden ? copy.hideHidden : copy.showHidden}</TooltipContent>
          </Tooltip>
          <PaneTabStrip
            tabs={open.map((tab) => ({ id: tab.path, label: fileLabel(tab.path), italic: !tab.pinned }))}
            activeId={activePath}
            onSelect={(path) => fileTabs.setActiveFile(chatSessionId, path)}
            onClose={(path) => fileTabs.closeTab(chatSessionId, path)}
          />
        </div>
      }
    >
      <div ref={dropContainerRef} className="relative flex h-full min-h-0">
        {/* Covers the panel instead of announcing itself in a strip at the
          * top: the drop target is the whole pane, so that is what should
          * light up. `pointer-events-none` keeps the tree underneath live —
          * the folder row under the cursor is what decides where the file
          * lands, and it can't stop receiving hover just because the overlay
          * is on top of it. */}
        {isDraggingOver && (
          <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2.5 border border-dashed border-primary bg-primary-soft">
            <span className="flex size-9 items-center justify-center border border-primary text-primary">
              <FolderInput className="size-4" />
            </span>
            <span className="font-mono text-xs text-foreground">{copy.drop.title}</span>
            <span className="max-w-[85%] truncate font-mono text-[11px] text-muted-foreground">
              {dropTargetPath ? copy.drop.toFolder.replace("{folder}", fileLabel(dropTargetPath)) : copy.drop.toRoot}
            </span>
          </div>
        )}
        <div className="h-full shrink-0 overflow-hidden" style={{ width: treeWidth }}>
          <FileTree
            profile={profile}
            sessionId={chatSessionId}
            root={root}
            expanded={expanded}
            activePath={activePath}
            showHidden={showHidden}
            changedDir={dirChanged}
            onToggleExpand={(path) => fileTabs.toggleExpanded(chatSessionId, path)}
            onOpenPreview={(path) => fileTabs.openPreview(chatSessionId, path)}
            onOpenPinned={(path) => fileTabs.openPinned(chatSessionId, path)}
            onFileDeleted={(path) => fileTabs.closeTab(chatSessionId, path)}
            onFileRenamed={(oldPath, newPath) => fileTabs.renamePath(chatSessionId, oldPath, newPath)}
            onOpenTerminal={onOpenTerminal}
            dropTargetPath={dropTargetPath}
          />
        </div>
        <div
          onPointerDown={startDrag}
          className={cn("w-1 shrink-0 cursor-col-resize border-r border-border-soft hover:bg-border", isDragging && "bg-border")}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {activePath ? (
            <>
              <div className="scrollbar-thin shrink-0 overflow-x-auto border-b border-border-soft px-3 py-1.5 font-mono text-[10.5px] whitespace-nowrap text-text-faint">
                {breadcrumbSegments(root, activePath).map((segment, index, all) => (
                  <span key={`${segment}-${String(index)}`}>
                    {index > 0 && <span className="px-1">/</span>}
                    {/* The file itself reads a step brighter than the folders
                      * leading to it — the path is context, the name is the
                      * subject. */}
                    <span className={index === all.length - 1 ? "text-muted-foreground" : undefined}>{segment}</span>
                  </span>
                ))}
              </div>
              <div className="min-h-0 flex-1">
                <FileViewer key={activePath} profile={profile} sessionId={chatSessionId} path={activePath} changedFile={fileChanged} />
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center font-mono text-[11px] text-muted-foreground">{copy.noFileOpen}</div>
          )}
        </div>
      </div>
    </SessionPanel>
  );
}
