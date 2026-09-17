import { useEffect, useState } from "react";
import { ChevronRight, Eye, EyeOff, Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDict } from "@/i18n";
import { listDirectories, type FsEntry } from "@/lib/relay/fsBrowse";
import type { Profile } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

interface FolderPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile;
  /** Folder from which the breadcrumb starts when the modal opens — the
   * session's current cwd (which is already "the app's default" when the
   * user never chose anything, resolved by the relay — see relay/src/paths.ts). */
  initialPath: string;
  /** If the session locked between the modal being opened and now (race
   * between two devices), closes itself — see effect below. */
  locked: boolean;
  onSelect: (path: string) => void;
  /** See comment on `WorkingDirectoryButtonProps.onFocusComposer` — same
   * reason, same fix, this time on the `Dialog`'s `onCloseAutoFocus`
   * (which by default would return focus to the trigger that opened the modal). */
  onFocusComposer: () => void;
}

interface Crumb {
  label: string;
  path: string;
}

/** `/home/user/mode/widgets` -> home > user > mode > widgets, each with the path
 * accumulated up to that point. Root becomes a static "/" crumb. */
function breadcrumbsFor(path: string): Crumb[] {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return [{ label: "/", path: "/" }];
  let acc = "";
  return segments.map((label) => {
    acc += `/${label}`;
    return { label, path: acc };
  });
}

function parentOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * Working directory picker modal — path field + navigable breadcrumb +
 * subfolder listing (never files) via `GET /fs/list` on the relay (the
 * machine where the agent runs, not the client device). Modeled on the
 * controlled `Dialog` from `EditLinkDialog.tsx`; unlike that one, this one
 * doesn't live inside the Composer's `<form>` (it's rendered from
 * `WorkingDirectoryButton`, a sibling of the Composer in `ChatPanel`), so
 * the `stopPropagation` care from there doesn't apply here.
 */
export function FolderPickerDialog({
  open,
  onOpenChange,
  profile,
  initialPath,
  locked,
  onSelect,
  onFocusComposer,
}: FolderPickerDialogProps) {
  const dict = useDict();
  const copy = dict.shell.folderPicker;
  const [browsePath, setBrowsePath] = useState(initialPath);
  const [pathInput, setPathInput] = useState(initialPath);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  // Not persisted — same as the file panel's own toggle, this is view state,
  // not worth surviving a restart. Defaults to filtered.
  const [showHidden, setShowHidden] = useState(false);

  async function navigate(path?: string, hidden = showHidden): Promise<boolean> {
    setLoading(true);
    try {
      const result = await listDirectories(profile, path, hidden);
      setBrowsePath(result.path);
      setPathInput(result.path);
      setEntries(result.entries);
      setError(null);
      setInitialLoadDone(true);
      return true;
    } catch (err) {
      // Doesn't touch `browsePath`/`entries` — if it was the path field that
      // failed, the typed text stays visible for the user to fix; if it was
      // a click (breadcrumb/folder/"..") the clickable path doesn't even change.
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setInitialLoadDone(false);
    setShowHidden(false);
    void (async () => {
      // Saved folder may have been deleted/lost permission since last time —
      // if the initial navigation fails, tries again with the app's default
      // instead of leaving the modal with nothing navigable.
      const ok = await navigate(initialPath, false);
      if (!ok) void navigate(undefined, false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && locked) onOpenChange(false);
  }, [open, locked, onOpenChange]);

  const crumbs = breadcrumbsFor(browsePath);
  const atRoot = browsePath === "/";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onFocusComposer();
        }}
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>

        <DialogBody className="gap-2.5">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = pathInput.trim();
              if (trimmed) void navigate(trimmed);
            }}
            className="flex items-center gap-1.5"
          >
            <Input
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              className="flex-1"
              spellCheck={false}
            />
            <Button type="submit" size="sm" variant="outline">
              {copy.go}
            </Button>
          </form>

          <div className="flex items-center justify-between gap-2">
            {/* Every segment is clickable, which is also how you go up — the
                breadcrumb is the navigation, not a label of where you are. */}
            <div className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-[11px]">
              {crumbs.map((crumb, index) => (
                <div key={crumb.path} className="flex items-center gap-1">
                  {index > 0 && <span className="text-text-faint">/</span>}
                  <button
                    type="button"
                    onClick={() => void navigate(crumb.path)}
                    className={cn(
                      "cursor-pointer px-1 py-0.5 transition-colors hover:text-foreground",
                      index === crumbs.length - 1 ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {crumb.label}
                  </button>
                </div>
              ))}
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    const next = !showHidden;
                    setShowHidden(next);
                    void navigate(browsePath, next);
                  }}
                  aria-label={showHidden ? copy.hideHidden : copy.showHidden}
                  className={cn("size-6 shrink-0", showHidden && "text-foreground")}
                >
                  {showHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{showHidden ? copy.hideHidden : copy.showHidden}</TooltipContent>
            </Tooltip>
          </div>

          <ScrollArea className="h-64 border border-border bg-bg-chrome p-1">
            {error ? (
              <div className="flex h-60 items-center justify-center px-4 text-center text-sm text-destructive">
                {error}
              </div>
            ) : (
              <div className="flex flex-col">
                {!atRoot && (
                  <button
                    type="button"
                    onClick={() => void navigate(parentOf(browsePath))}
                    className="flex shrink-0 cursor-pointer items-center gap-2.5 px-2 py-1.5 text-left font-mono text-xs text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                  >
                    <Folder className="size-3.5 shrink-0" />
                    <span className="flex-1">..</span>
                    <span className="sr-only">{copy.parent}</span>
                  </button>
                )}

                {loading && <div className="px-2 py-1.5 font-mono text-xs text-text-faint">{dict.common.loading}</div>}

                {!loading && entries.length === 0 && (
                  <div className="px-3 py-8 text-center font-mono text-[11.5px] text-text-faint">{copy.empty}</div>
                )}

                {!loading &&
                  entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => void navigate(entry.path)}
                      className="flex shrink-0 cursor-pointer items-center gap-2.5 px-2 py-1.5 text-left font-mono text-xs text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                    >
                      <Folder className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <ChevronRight className="size-3 shrink-0 text-text-faint" />
                    </button>
                  ))}
              </div>
            )}
          </ScrollArea>
        </DialogBody>

        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            {dict.common.cancel}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!initialLoadDone || error !== null}
            onClick={() => {
              onSelect(browsePath);
              onOpenChange(false);
            }}
          >
            {copy.select}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
