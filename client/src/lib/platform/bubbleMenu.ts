import { invoke } from "@tauri-apps/api/core";
import type { NativeMenuItem } from "@/lib/platform/nativeContextMenu";

export interface BubbleMenuRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BubbleMenuTransport {
  send: (target: { id: string; rect: BubbleMenuRect | null; items: NativeMenuItem[] }) => void;
}

/**
 * Arms the native long-press menu for one chat bubble. The system gesture runs
 * natively, so it has to know beforehand which rectangle is a bubble and what
 * its menu holds: a bubble arms itself on `touchstart`, which lands well before
 * the hold completes. Native reports the picked item back through `dispatch`.
 * At most one target is armed; a touch that starts elsewhere disarms it.
 */
export function createBubbleMenu(transport: BubbleMenuTransport) {
  let armed: { id: string; onSelect: (itemId: string) => void } | null = null;
  return {
    arm(target: { id: string; rect: BubbleMenuRect; items: NativeMenuItem[]; onSelect: (itemId: string) => void }): void {
      armed = { id: target.id, onSelect: target.onSelect };
      transport.send({ id: target.id, rect: target.rect, items: target.items });
    },
    /** No-op when nothing is armed, so a plain tap costs no round trip. */
    disarm(): void {
      if (!armed) return;
      const { id } = armed;
      armed = null;
      transport.send({ id, rect: null, items: [] });
    },
    /** A pick for a target that is no longer the armed one is ignored. */
    dispatch(event: { targetId: string; itemId: string }): void {
      if (armed?.id === event.targetId) armed.onSelect(event.itemId);
    },
  };
}

export const bubbleMenu = createBubbleMenu({
  send: (target) => void invoke("plugin:native-chrome|set_context_target", { payload: target }).catch(() => {}),
});
