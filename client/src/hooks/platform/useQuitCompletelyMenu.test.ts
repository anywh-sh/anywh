import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LocaleProvider, useLocale } from "@/i18n";
import { quitCompletelyPosition, useQuitCompletelyMenu, type QuitCompletelyMenu } from "./useQuitCompletelyMenu";

function fakeMenu(bundled: boolean) {
  const installed: string[] = [];
  const menu: QuitCompletelyMenu = {
    bundled: () => Promise.resolve(bundled),
    install: (text) => {
      installed.push(text);
      return Promise.resolve();
    },
  };
  return { menu, installed };
}

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const wrapper = ({ children }: { children: ReactNode }) => createElement(LocaleProvider, null, children);

describe("useQuitCompletelyMenu", () => {
  it("offers the item only on a Mac app that ships its own relay", async () => {
    const shipped = fakeMenu(true);
    renderHook(() => useQuitCompletelyMenu(shipped.menu, true), { wrapper });
    await flush();
    expect(shipped.installed).toEqual(["Quit Completely"]);

    const homebrewOrIntel = fakeMenu(false);
    renderHook(() => useQuitCompletelyMenu(homebrewOrIntel.menu, true), { wrapper });
    await flush();
    expect(homebrewOrIntel.installed).toEqual([]);

    const notMac = fakeMenu(true);
    renderHook(() => useQuitCompletelyMenu(notMac.menu, false), { wrapper });
    await flush();
    expect(notMac.installed).toEqual([]);
  });

  it("puts the item back in the new language when the language changes", async () => {
    const { menu, installed } = fakeMenu(true);
    const { result } = renderHook(
      () => {
        useQuitCompletelyMenu(menu, true);
        return useLocale();
      },
      { wrapper },
    );
    await flush();
    act(() => result.current.setLocale("pt-BR"));
    await flush();
    expect(installed).toEqual(["Quit Completely", "Sair completamente"]);
  });

  it("goes right above the regular Quit, the app menu's last item", () => {
    expect(quitCompletelyPosition(9)).toBe(8);
    expect(quitCompletelyPosition(0)).toBe(0);
  });
});
