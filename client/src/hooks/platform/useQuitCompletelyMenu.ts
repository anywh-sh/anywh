import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDict } from "@/i18n";
import { currentPlatform } from "@/lib/platform/platform";
import { inTauri } from "@/lib/platform/tauri";

/** The app menu's "Quit Completely". Closing a Mac app that ships its own
 * relay leaves that relay running under launchd until logout, so the phone
 * keeps reaching this Mac; this item also stops it (relay_quit_completely). */
export interface QuitCompletelyMenu {
  /** Whether this app ships its own relay: only then is there anything
   * beyond a normal quit to offer. */
  bundled(): Promise<boolean>;
  /** Puts the item, with this text, in the app menu (replacing the one
   * there before, if any). */
  install(text: string): Promise<void>;
}

/** Where the item goes among the app submenu's items: right above the last
 * one, the regular Quit. */
export function quitCompletelyPosition(itemCount: number): number {
  return Math.max(0, itemCount - 1);
}

const tauriMenu: QuitCompletelyMenu = {
  bundled: () => invoke<boolean>("relay_bundled"),
  async install(text) {
    // The default macOS menu (app, Edit, View, Window...), rebuilt whole each
    // time so a language change never leaves the old item behind.
    const { Menu, MenuItem, Submenu } = await import("@tauri-apps/api/menu");
    const menu = await Menu.default();
    const [appMenu] = await menu.items();
    if (!(appMenu instanceof Submenu)) return;
    const item = await MenuItem.new({
      id: "anywh-quit-completely",
      text,
      action: () => {
        invoke("relay_quit_completely").catch((err: unknown) => console.warn("[anywh] quit completely failed", err));
      },
    });
    await appMenu.insert(item, quitCompletelyPosition((await appMenu.items()).length));
    await menu.setAsAppMenu();
  },
};

export function useQuitCompletelyMenu(menu: QuitCompletelyMenu = tauriMenu, enabled: boolean = inTauri() && currentPlatform() === "macos"): void {
  const text = useDict().shell.quitCompletely;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    menu
      .bundled()
      .then((bundled) => (bundled && !cancelled ? menu.install(text) : undefined))
      .catch((err: unknown) => console.warn("[anywh] couldn't add Quit Completely to the app menu", err));
    return () => {
      cancelled = true;
    };
  }, [menu, enabled, text]);
}
