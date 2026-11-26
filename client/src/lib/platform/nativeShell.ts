import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { listenPluginEvents } from "@/lib/platform/pluginEvents";

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

/** Contents of the dropdown the top bar's center opens. */
export interface NativeTopBarMenuPayload {
  /** `null` = nothing to offer: the bar stays a plain label. */
  model: {
    label: string;
    currentId: string | null;
    currentLabel: string;
    options: { id: string; label: string }[];
    locked: boolean;
    lockedHint: string;
    enabled: boolean;
  } | null;
  /** Same `null` rule as `model`. */
  mode: {
    label: string;
    currentId: string | null;
    currentLabel: string;
    options: { id: string; label: string; hint: string }[];
    enabled: boolean;
  } | null;
  /** Same `null` rule as `model` (none when the effective model takes no
   * effort). Never locked. When the CLI reports no default effort, the first
   * option is the "no pick" row (id `default`). */
  effort: {
    label: string;
    currentId: string | null;
    currentLabel: string;
    options: { id: string; label: string }[];
    enabled: boolean;
  } | null;
  /** The agent the conversation runs on. `null` when the relay reports fewer
   * than two agents; locked exactly when `model` is (after the first turn).
   * Optional on the native side, so an older web build that never sends it
   * still decodes. */
  agent: {
    label: string;
    currentId: string | null;
    currentLabel: string;
    options: { id: string; label: string }[];
    locked: boolean;
    lockedHint: string;
    enabled: boolean;
  } | null;
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

/** A bot as the drawer's Bots section lists it. Its face arrives drawn: 256
 * characters, row by row, `.` empty and `a`, `b`, … the first, second, …
 * color of `mascotPalette` (see `mascotPixels` in `mascot.ts`). */
export interface NativeDrawerBot {
  id: string;
  roomId: string;
  name: string;
  /** Pre-formatted status line. */
  line: string;
  tone: "attention" | "fail" | "normal";
  mascot: string;
  mascotPalette: string[];
  /** The corner mark: `needsYou`, `failed`, `working`, `paused`, `limit`, or none. */
  badge: string | null;
  selected: boolean;
}

/** The drawer's two sections: Bots and Conversations take turns, the open one
 * on top, the other folded to its heading at the bottom. */
export interface NativeDrawerBots {
  section: "bots" | "conversations";
  botsLabel: string;
  conversationsLabel: string;
  newBotLabel: string;
  emptyTitle: string;
  emptyBody: string;
  /** Shown on the folded Bots heading when some bot needs the person; empty otherwise. */
  waitingLabel: string;
  items: NativeDrawerBot[];
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
  /** Absent for a build without bots: the drawer is the conversations alone. */
  bots?: NativeDrawerBots;
}

/** Events the native shell sends back. Native only captures input and draws;
 * what each of these means is decided by the handlers. */
export interface NativeShellHandlers {
  drawerSelect: (event: { sessionId: string; profileId: string }) => void;
  drawerProfileChange: (event: { profileId: string }) => void;
  drawerRetry: () => void;
  drawerRename: (event: { sessionId: string; profileId: string; title: string }) => void;
  drawerDelete: (event: { sessionId: string; profileId: string }) => void;
  drawerSelectBot: (event: { botId: string }) => void;
  drawerNewBot: () => void;
  drawerSection: (event: { section: string }) => void;
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
export function listenNativeShell(handlers: NativeShellHandlers): Promise<() => void> {
  return listenPluginEvents("native-chrome", handlers);
}

export function setNativeTopBarMenu(payload: NativeTopBarMenuPayload): Promise<void> {
  return invoke("plugin:native-chrome|set_top_bar_menu", { payload });
}

/** Fires when the user picks a model in the top bar dropdown. */
export async function listenTopBarModelSelect(handler: (event: { modelId: string }) => void): Promise<() => void> {
  const listener = await addPluginListener("native-chrome", "topBarModelSelect", handler);
  return () => void listener.unregister();
}

/** Fires when the user picks an agent in the top bar dropdown. */
export async function listenTopBarAgentSelect(handler: (event: { agentId: string }) => void): Promise<() => void> {
  const listener = await addPluginListener("native-chrome", "topBarAgentSelect", handler);
  return () => void listener.unregister();
}

/** Fires when the user picks a reasoning effort in the top bar dropdown. */
export async function listenTopBarEffortSelect(handler: (event: { effortId: string }) => void): Promise<() => void> {
  const listener = await addPluginListener("native-chrome", "topBarEffortSelect", handler);
  return () => void listener.unregister();
}

/** Fires when the user picks a permission mode in the top bar dropdown. */
export async function listenTopBarModeSelect(handler: (event: { modeId: string }) => void): Promise<() => void> {
  const listener = await addPluginListener("native-chrome", "topBarModeSelect", handler);
  return () => void listener.unregister();
}
