import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "@/lib/platform/tauri";

export function useWindowControls(): {
  isMaximized: boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
} {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!inTauri()) return;
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void appWindow.isMaximized().then(setIsMaximized);
    void appWindow
      .onResized(() => {
        void appWindow.isMaximized().then(setIsMaximized);
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => unlisten?.();
  }, []);

  const minimize = useCallback(() => {
    if (inTauri()) void getCurrentWindow().minimize();
  }, []);

  const toggleMaximize = useCallback(() => {
    if (inTauri()) void getCurrentWindow().toggleMaximize();
  }, []);

  const close = useCallback(() => {
    if (inTauri()) void getCurrentWindow().close();
  }, []);

  return { isMaximized, minimize, toggleMaximize, close };
}
