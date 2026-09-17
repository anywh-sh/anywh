import { useRef, useState } from "react";
import { Check, Copy, Folder } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRecentFolders } from "@/hooks/useRecentFolders";
import { useDict } from "@/i18n";
import { FolderPickerDialog } from "@/components/chat/FolderPickerDialog";
import { profileColorVar, type Profile } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

interface WorkingDirectoryButtonProps {
  profile: Profile;
  cwd: string | null;
  locked: boolean;
  connected: boolean;
  /** Tab opened via "new conversation" — the folder is always immediately
   * choosable here (the session never starts locked), so the button
   * doesn't wait for the WS connection to open nor for the first
   * `cwd_state` to arrive: listing folders is its own REST call
   * (`GET /fs/list`, no `path` resolves to the profile's default) and the
   * actual selection stays queued in RelayClient until the connection opens
   * (see relayClient.ts). An existing session still requires a connection —
   * erring on the safe side avoids unlocking a folder that's actually
   * already locked, we just haven't confirmed it yet. */
  isNewConversation?: boolean;
  onSetCwd: (path: string) => void;
  /** Returns focus to the composer when the dropdown or the
   * `FolderPickerDialog` close — without this Radix restores focus to this
   * button's trigger by default (`onCloseAutoFocus`), so picking a folder
   * would leave the user unable to type right away, having to click the
   * field again. */
  onFocusComposer: () => void;
}

/** Just the last folder's name from the path, so the button/list don't get
 * huge — the full path appears in the tooltip and the "Working directory"
 * dropdown. */
function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const lastSegment = trimmed.split("/").pop();
  return lastSegment || "/";
}

/**
 * Shows (and lets you change) the current session's working directory. On
 * desktop it is portalled into the centre of the title bar by `ChatPanel`;
 * on iOS, which has no title bar, it stays above the `Composer`. Before the first turn,
 * the dropdown lists "Recent" (per profile, `useRecentFolders`) + "Choose
 * folder...". After the first turn the relay locks the folder (see
 * `SharedSession.runTurn` — Claude Code's session_id gets tied to the cwd
 * used at spawn), so the dropdown becomes view-only + "Copy path".
 */
export function WorkingDirectoryButton({
  profile,
  cwd,
  locked,
  connected,
  isNewConversation,
  onSetCwd,
  onFocusComposer,
}: WorkingDirectoryButtonProps) {
  const dict = useDict();
  const { recents, addRecent } = useRecentFolders(profile.id);
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function selectFolder(path: string): void {
    onSetCwd(path);
    addRecent(path);
  }

  async function copyPath(): Promise<void> {
    if (!cwd) return;
    try {
      await navigator.clipboard.writeText(cwd);
    } catch {
      window.alert(dict.shell.workingDirectory.copyFailed);
    }
  }

  return (
    <>
      <DropdownMenu
        // Radix traps focus + `pointer-events: none` on the body while the
        // modal menu is open, and restores both on close — on WKWebView
        // (Tauri on macOS) that restoration fails right when the "Recent"
        // list reorders between one opening and the next (chosen item moves
        // to the top, position keys change): the next opening loses the
        // whole section, leaving only "Choose folder...". `modal={false}`
        // takes that mechanism out of the way (we don't need a focus trap here).
        modal={false}
        onOpenChange={(open) => {
          // Without this the focus stays on the trigger after the menu
          // closes, and since the Tooltip also opens on focus (not just
          // hover), it gets "stuck" open until the mouse leaves and comes
          // back — even while already far from the button.
          if (!open) triggerRef.current?.blur();
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                disabled={!isNewConversation && (!cwd || !connected)}
                className="flex h-[26px] max-w-full shrink cursor-pointer items-center gap-2 border border-border bg-bg-sidebar px-2.5 font-mono text-[11.5px] text-muted-foreground transition-colors hover:border-text-faint hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {/* The design ties this icon to the tab's own profile color
                  * (`tabColor`), not the accent — the working directory
                  * belongs to whichever profile the current tab is on. */}
                <Folder className="size-3 shrink-0" style={{ color: profileColorVar(profile.id) }} />
                <span className="truncate">{cwd ? folderName(cwd) : "…"}</span>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {cwd ?? (isNewConversation ? dict.shell.workingDirectory.chooseFolder : dict.shell.workingDirectory.connecting)}
          </TooltipContent>
        </Tooltip>

        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onFocusComposer();
          }}
        >
          {locked ? (
            <>
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span>{dict.shell.workingDirectory.heading}</span>
                <span className="truncate font-mono text-xs text-foreground">{cwd}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void copyPath()}>
                <Copy className="size-3.5" />
                {dict.shell.workingDirectory.copyPath}
              </DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuLabel>{dict.shell.workingDirectory.recent}</DropdownMenuLabel>
              {recents.length === 0 ? (
                <div className="px-2 py-1.5 font-mono text-xs text-muted-foreground">{dict.shell.workingDirectory.noRecent}</div>
              ) : (
                recents.map((path) => (
                  <DropdownMenuItem key={path} title={path} onSelect={() => selectFolder(path)}>
                    <Check className={cn("size-3.5", path !== cwd && "opacity-0")} />
                    <span className="truncate">{folderName(path)}</span>
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setPickerOpen(true)}>{dict.shell.workingDirectory.browse}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <FolderPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        profile={profile}
        initialPath={cwd ?? ""}
        locked={locked}
        onSelect={selectFolder}
        onFocusComposer={onFocusComposer}
      />
    </>
  );
}
