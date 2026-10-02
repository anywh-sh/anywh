import { useEffect, useMemo, useRef, useState } from "react";
import { useDict, useLocale } from "@/i18n";
import { parseColor } from "@/lib/theme/color";
import { profileColorVar, type Profile } from "@/lib/profiles/profiles";
import type { MergedSession } from "@/lib/format/sessionGrouping";
import { blocksDrawerGesture } from "@/lib/platform/drawerGestureHint";
import { listenNativeShell, setNativeDrawer, setNativeGestureHint, setNativeTopBar } from "@/lib/platform/nativeShell";
import { buildDrawerPayload, buildShellTheme, buildTopBarPayload } from "@/lib/platform/nativeShellModel";

interface UseNativeShellArgs {
  /** Only iOS has the native shell; elsewhere the hook does nothing. */
  enabled: boolean;
  sessions: MergedSession[];
  profiles: Profile[];
  activeProfileId: string;
  selectedSessionId: string | null;
  running: ReadonlySet<string>;
  backgroundJobSessions: ReadonlySet<string>;
  sessionsLoading: boolean;
  sessionsError: boolean;
  title: string;
  modelLabel: string | null;
  connected: boolean;
  onSelectSession: (session: MergedSession) => void;
  onProfileChange: (profileId: string) => void;
  onOpenSearch: () => void;
  onRetrySessions: () => void;
  onRenameSession: (profileId: string, sessionId: string, title: string) => void;
  onDeleteSession: (profileId: string, sessionId: string) => void;
  onNewConversation: () => void;
}

const FALLBACK_COLOR = "#000000";

function toHex(css: string): string {
  const rgba = parseColor(css);
  if (!rgba) return FALLBACK_COLOR;
  const byte = (n: number): string => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${byte(rgba.r)}${byte(rgba.g)}${byte(rgba.b)}${rgba.a < 1 ? byte(rgba.a * 255) : ""}`;
}

/** Bumps whenever the root element's inline style changes, which is where a
 * theme is applied (`applyResolvedTheme`) — the native colors follow it. */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-appearance"] });
    return () => observer.disconnect();
  }, []);
  return version;
}

/**
 * Drives the iOS native shell (top bar + conversation drawer): sends it the
 * pre-formatted state whenever that changes, tells it when a touch starts on
 * something that scrolls sideways, and routes what it reports back to the
 * app's own handlers. Native code never decides anything; it draws and
 * captures gestures.
 */
export function useNativeShell(args: UseNativeShellArgs): void {
  const dict = useDict();
  const { locale } = useLocale();
  const themeVersion = useThemeVersion();

  const theme = useMemo(
    () => buildShellTheme(toHex),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeVersion],
  );

  const { title, modelLabel, connected } = args;
  const topBar = useMemo(
    () => buildTopBarPayload({ title, modelLabel, connected, dict, theme }),
    [title, modelLabel, connected, dict, theme],
  );
  const { enabled } = args;
  useEffect(() => {
    if (enabled) void setNativeTopBar(topBar).catch(() => {});
  }, [enabled, topBar]);

  const { sessions, profiles, activeProfileId, selectedSessionId, running, backgroundJobSessions, sessionsLoading, sessionsError } = args;
  const drawer = useMemo(
    () =>
      buildDrawerPayload({
        sessions,
        profiles,
        activeProfileId,
        selectedSessionId,
        running,
        backgroundJobSessions,
        loading: sessionsLoading,
        error: sessionsError,
        dict,
        locale,
        theme,
        profileCssColor: profileColorVar,
        resolve: toHex,
      }),
    [sessions, profiles, activeProfileId, selectedSessionId, running, backgroundJobSessions, sessionsLoading, sessionsError, dict, locale, theme],
  );
  useEffect(() => {
    if (enabled) void setNativeDrawer(drawer).catch(() => {});
  }, [enabled, drawer]);

  // The native side calls these long after render; reading through a ref
  // keeps the subscription from being torn down on every app render.
  const argsRef = useRef(args);
  argsRef.current = args;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenNativeShell({
      drawerSelect: ({ sessionId, profileId }) => {
        const session = argsRef.current.sessions.find((s) => s.id === sessionId && s.profileId === profileId);
        if (session) argsRef.current.onSelectSession(session);
      },
      drawerProfileChange: ({ profileId }) => argsRef.current.onProfileChange(profileId),
      drawerSearch: () => argsRef.current.onOpenSearch(),
      drawerRetry: () => argsRef.current.onRetrySessions(),
      drawerRename: ({ sessionId, profileId, title: next }) => argsRef.current.onRenameSession(profileId, sessionId, next),
      drawerDelete: ({ sessionId, profileId }) => argsRef.current.onDeleteSession(profileId, sessionId),
      topBarNewConversation: () => argsRef.current.onNewConversation(),
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let last: boolean | null = null;
    const onTouchStart = (event: TouchEvent): void => {
      const blocked = blocksDrawerGesture(event.target);
      if (blocked === last) return;
      last = blocked;
      void setNativeGestureHint(blocked).catch(() => {});
    };
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    return () => document.removeEventListener("touchstart", onTouchStart, { capture: true });
  }, [enabled]);
}
