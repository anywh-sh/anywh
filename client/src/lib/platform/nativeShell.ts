import { addPluginListener, invoke } from "@tauri-apps/api/core";

/** Colors of the shell chrome as `#rrggbb[aa]`. Native code paints them as
 * given; it never reads the app's CSS. */
export interface NativeShellTheme {
  background: string;
  sidebar: string;
  elevated: string;
  card: string;
  foreground: string;
  muted: string;
  faint: string;
  border: string;
  primary: string;
  /** Ink drawn on top of `primary` (the send button's arrow). */
  primaryForeground: string;
  destructive: string;
  tint: string;
  success: string;
}

export interface NativeTopBarPayload {
  title: string;
  /** `null` while the session's model is not known yet — the bar then shows the title alone. */
  modelLabel: string | null;
  connected: boolean;
  openSidebarLabel: string;
  newConversationLabel: string;
  /** Accessibility label of the connection dot. */
  connectionLabel: string;
  theme: NativeShellTheme;
}

export interface NativeDrawerStrings {
  /** Label of the button after the list, shown when there are more sessions. */
  allChats: string;
  loadFailed: string;
  retry: string;
  emptyTitle: string;
  emptyBody: string;
  rename: string;
  renameTitle: string;
  renameDescription: string;
  delete: string;
  deleteTitle: string;
  /** Contains `{title}`, substituted natively with the session's title. */
  deleteBody: string;
  cancel: string;
  save: string;
  agentWorking: string;
  backgroundJob: string;
}

export interface NativeDrawerSession {
  id: string;
  profileId: string;
  title: string;
  /** Pre-formatted second line; empty when there is nothing to show. */
  meta: string;
  color: string;
  running: boolean;
  backgroundJob: boolean;
  selected: boolean;
}

export interface NativeDrawerGroup {
  id: string;
  /** Heading including the count, already localized. */
  label: string;
  sessions: NativeDrawerSession[];
}

export interface NativeDrawerPayload {
  theme: NativeShellTheme;
  strings: NativeDrawerStrings;
  profiles: { id: string; label: string; color: string }[];
  activeProfileId: string;
  loading: boolean;
  error: boolean;
  /** More sessions exist than the groups carry. */
  hasMore: boolean;
  groups: NativeDrawerGroup[];
}

/** Events the native shell sends back. Native only captures input and draws;
 * what each of these means is decided by the handlers. */
export interface NativeShellHandlers {
  drawerSelect: (event: { sessionId: string; profileId: string }) => void;
  drawerProfileChange: (event: { profileId: string }) => void;
  drawerRetry: () => void;
  drawerRename: (event: { sessionId: string; profileId: string; title: string }) => void;
  drawerDelete: (event: { sessionId: string; profileId: string }) => void;
  topBarNewConversation: () => void;
  contextMenuSelect: (event: { targetId: string; itemId: string }) => void;
}

export function setNativeTopBar(payload: NativeTopBarPayload): Promise<void> {
  return invoke("plugin:native-chrome|set_top_bar", { payload });
}

export function setNativeDrawer(payload: NativeDrawerPayload): Promise<void> {
  return invoke("plugin:native-chrome|set_drawer", { payload });
}

export function setNativeGestureHint(blocked: boolean): Promise<void> {
  return invoke("plugin:native-chrome|set_gesture_hint", { payload: { blocked } });
}

/** Subscribes to every native shell event. Resolves to one function that
 * removes them all. */
export async function listenNativeShell(handlers: NativeShellHandlers): Promise<() => void> {
  const names = Object.keys(handlers) as (keyof NativeShellHandlers)[];
  const listeners = await Promise.all(
    names.map((name) => addPluginListener("native-chrome", name, (event: never) => (handlers[name] as (event: never) => void)(event))),
  );
  return () => {
    for (const listener of listeners) void listener.unregister();
  };
}
