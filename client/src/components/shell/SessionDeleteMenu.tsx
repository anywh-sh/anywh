import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { Columns2, Pencil, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useDict } from "@/i18n";
import { ContextMenuAnchor, type ContextMenuState } from "@/hooks/platform/useContextMenu";

interface SessionDeleteMenuProps {
  menu: ContextMenuState;
  title: string;
  onDelete: () => void;
  onRename: () => void;
  /** Optional: only TabGroupStrip passes this — one of the three ways to
   * split a tab into its own group (the other two: drag it to the content
   * area's edge, or `Ctrl+\`). No-op (and hidden) when the tab is already
   * alone in its group, same guard `splitTabToNewGroup` itself enforces. */
  onMoveToNewGroup?: () => void;
}

/** Invisible trigger anchored to the cursor (see useContextMenu). Reused by
 * SessionList (left panel) and TabGroupStrip (tab), the two places where a
 * right-click opens this menu.
 *
 * The confirmation uses `@tauri-apps/plugin-dialog`'s `confirm` — a real
 * native OS dialog via Rust, not `window.confirm` (the WebView's own JS
 * dialog, unreliable across platforms per the project's known pitfalls). */
export function SessionDeleteMenu({ menu, title, onDelete, onRename, onMoveToNewGroup }: SessionDeleteMenuProps) {
  const dict = useDict();
  const strings = dict.shell.sidebar.sessionMenu;

  async function confirmDelete(): Promise<void> {
    const confirmed = await confirmDialog(strings.deleteBody.replace("{title}", title), {
      title: strings.deleteTitle,
      kind: "warning",
      okLabel: dict.common.delete,
      cancelLabel: dict.common.cancel,
    });
    if (confirmed) onDelete();
  }

  return (
    <DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
      <ContextMenuAnchor position={menu.position} />
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            menu.setOpen(false);
            onRename();
          }}
        >
          <Pencil />
          {strings.rename}
        </DropdownMenuItem>
        {onMoveToNewGroup && (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              menu.setOpen(false);
              onMoveToNewGroup();
            }}
          >
            <Columns2 />
            {strings.moveToNewGroup}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          variant="destructive"
          onSelect={(event) => {
            event.preventDefault();
            menu.setOpen(false);
            void confirmDelete();
          }}
        >
          <Trash2 />
          {strings.delete}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
