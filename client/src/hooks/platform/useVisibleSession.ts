import { useEffect } from "react";
import { setVisibleSession } from "@/lib/platform/nativePush";
import { isIOS } from "@/lib/platform/platform";

/**
 * Tells the native side which conversation is in front of the person (`null`
 * while the app is in the background), so a remote notification about that
 * conversation is not shown over it. iOS only — nowhere else do remote
 * notifications go through the native delegate this feeds.
 */
export function useVisibleSession(sessionId: string | null, appFocused: boolean): void {
  const visible = appFocused ? sessionId : null;
  useEffect(() => {
    if (!isIOS()) return;
    setVisibleSession(visible).catch((error: unknown) => console.error("failed to report the visible session:", error));
  }, [visible]);

  useEffect(() => {
    if (!isIOS()) return;
    return () => {
      setVisibleSession(null).catch(() => undefined);
    };
  }, []);
}
