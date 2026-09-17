import { useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export interface ContextMenuState {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Fixed (viewport) position where the menu should anchor — follows the
   * cursor at the moment of the right-click, not the element's position. */
  position: { x: number; y: number };
  onContextMenu: (event: MouseEvent) => void;
}

/**
 * State for a menu anchored at the right-click point, instead of Radix's
 * default left-click — reuses the design system's `DropdownMenu`
 * (controlled via `open`/`onOpenChange` + an invisible trigger positioned
 * at the cursor) instead of bringing in Radix's `ContextMenu` primitive
 * just for this. Used by `SessionListItem` (left panel) and `TabGroupStrip` (tab).
 */
export function useContextMenu(): ContextMenuState {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    // Stops a row's own menu (a file/folder in `FileTree`) from also
    // triggering an ancestor's menu (the file panel's background "new
    // file") — harmless for every other caller today, none of which nests
    // one of these inside another.
    event.stopPropagation();
    setPosition({ x: event.clientX, y: event.clientY });
    setOpen(true);
  }

  return { open, setOpen, position, onContextMenu };
}

/**
 * The invisible trigger every `useContextMenu` caller anchors its
 * `DropdownMenu` to. Portaled straight to `document.body` instead of
 * rendering inline where the row's own JSX sits — a session tab's content
 * (`TabGroupLayout`) wraps each panel in `contain: layout paint` for its own
 * unrelated reasons (scoping re-layout so a sibling group's resize can't
 * disturb it), and CSS containment makes that wrapper a positioning
 * containing block for *any* `position: fixed` descendant, this span
 * included. Left inline, `left`/`top` (set from `event.clientX`/`clientY`,
 * viewport coordinates) resolve against the wrapper's box instead of the
 * viewport, so the menu opens offset by however far the wrapper sits from
 * the viewport origin — a large, direction-dependent gap between the click
 * and the menu instead of right under the cursor. Portaling the trigger
 * itself (not just `DropdownMenuContent`, which is already portaled by
 * `DropdownMenuPortal`) escapes that containing block; `DropdownMenuTrigger`
 * still resolves its parent `DropdownMenu` via React context, which portals
 * don't affect.
 */
export function ContextMenuAnchor({ position }: { position: { x: number; y: number } }) {
  return createPortal(
    <DropdownMenuTrigger asChild>
      <span className="pointer-events-none fixed" style={{ left: position.x, top: position.y }} />
    </DropdownMenuTrigger>,
    document.body,
  );
}
