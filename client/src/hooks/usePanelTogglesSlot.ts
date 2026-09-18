import { useSyncExternalStore } from "react";
import { getPanelTogglesSlot, subscribePanelTogglesSlot } from "@/lib/panelTogglesSlot";

/**
 * A tab group's toggle-pair slot, or `null` when this caller shouldn't claim
 * one — pass `null` for `groupId` (not its group's active tab, or there is
 * no group at all, e.g. iOS) rather than always subscribing and filtering
 * afterward, since the point is to portal nothing at all in that case.
 */
export function usePanelTogglesSlot(groupId: string | null): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => (groupId ? subscribePanelTogglesSlot(groupId, listener) : () => {}),
    () => (groupId ? getPanelTogglesSlot(groupId) : null),
    () => null,
  );
}
