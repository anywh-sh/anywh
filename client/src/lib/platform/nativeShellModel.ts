import type { Dictionary } from "@/i18n/dictionary";
import type { Locale } from "@/i18n";
import { formatRelativeTime } from "@/lib/format/relativeTime";
import { groupSessionsByRecency, type MergedSession } from "@/lib/format/sessionGrouping";
import type { Profile } from "@/lib/profiles/profiles";
import type {
  NativeDrawerPayload,
  NativeDrawerSession,
  NativeShellTheme,
  NativeTopBarPayload,
} from "@/lib/platform/nativeShell";

/** Turns a CSS color (`var(--x)` included) into `#rrggbb[aa]`. */
export type ResolveColor = (cssColor: string) => string;

/** The CSS variables behind each theme slot. */
const THEME_VARS: Record<keyof NativeShellTheme, string> = {
  background: "--background",
  sidebar: "--bg-sidebar",
  elevated: "--bg-elevated",
  card: "--card",
  foreground: "--foreground",
  muted: "--muted-foreground",
  faint: "--text-faint",
  border: "--border",
  primary: "--primary",
  destructive: "--destructive",
  tint: "--glass-tint",
  success: "--primary",
};

export function buildShellTheme(resolve: ResolveColor): NativeShellTheme {
  const theme = {} as Record<keyof NativeShellTheme, string>;
  for (const slot of Object.keys(THEME_VARS) as (keyof NativeShellTheme)[]) theme[slot] = resolve(`var(${THEME_VARS[slot]})`);
  return theme;
}

/** How many sessions the drawer lists before the "All chats" button. */
export const DRAWER_SESSION_LIMIT = 10;

export interface DrawerModelInput {
  sessions: MergedSession[];
  profiles: Profile[];
  activeProfileId: string;
  selectedSessionId: string | null;
  running: ReadonlySet<string>;
  backgroundJobSessions: ReadonlySet<string>;
  loading: boolean;
  error: boolean;
  dict: Dictionary;
  locale: Locale;
  theme: NativeShellTheme;
  /** A profile's accent as a CSS color (`var(--profile-N)`). */
  profileCssColor: (profileId: string) => string;
  resolve: ResolveColor;
  now?: number;
}

/**
 * Everything the native drawer renders, formatted here so the native side
 * holds no logic and no copy. The drawer lists the active profile's sessions
 * only (the profile picker is how the others are reached), capped at the
 * latest `DRAWER_SESSION_LIMIT` with `hasMore` flagging the rest. A row shows
 * at most one indicator (a running turn wins over a background job), and a
 * missing timestamp leaves the time out rather than inventing one. The meta
 * line is the time alone: the row's colour already says which profile it is.
 */
export function buildDrawerPayload(input: DrawerModelInput): NativeDrawerPayload {
  const { dict, locale, profiles } = input;
  const sidebar = dict.shell.sidebar;
  const profileSessions = input.sessions.filter((session) => session.profileId === input.activeProfileId);
  const visible = profileSessions.slice(0, DRAWER_SESSION_LIMIT);
  const colors = new Map<string, string>();
  const colorOf = (profileId: string): string => {
    let color = colors.get(profileId);
    if (color === undefined) {
      color = input.resolve(input.profileCssColor(profileId));
      colors.set(profileId, color);
    }
    return color;
  };

  const toRow = (session: MergedSession): NativeDrawerSession => {
    const running = input.running.has(session.id);
    return {
      id: session.id,
      profileId: session.profileId,
      title: session.title,
      meta: session.lastActiveAt === null ? "" : formatRelativeTime(session.lastActiveAt, locale),
      color: colorOf(session.profileId),
      running,
      backgroundJob: !running && input.backgroundJobSessions.has(session.id),
      selected: input.selectedSessionId === session.id,
    };
  };

  return {
    theme: input.theme,
    strings: {
      allChats: sidebar.allChats,
      loadFailed: sidebar.loadFailed,
      retry: dict.common.retry,
      emptyTitle: sidebar.emptyTitle,
      emptyBody: sidebar.emptyBody,
      rename: sidebar.sessionMenu.rename,
      renameTitle: sidebar.rename.title,
      renameDescription: sidebar.rename.description,
      delete: sidebar.sessionMenu.delete,
      deleteTitle: sidebar.sessionMenu.deleteTitle,
      deleteBody: sidebar.sessionMenu.deleteBody,
      cancel: dict.common.cancel,
      save: dict.common.save,
      agentWorking: sidebar.agentWorking,
      backgroundJob: sidebar.backgroundJob,
    },
    profiles: profiles.map((profile) => ({ id: profile.id, label: profile.label, color: colorOf(profile.id) })),
    activeProfileId: input.activeProfileId,
    // Skeleton only while there is nothing to show yet; a refresh keeps the list.
    loading: input.loading && input.sessions.length === 0,
    hasMore: profileSessions.length > visible.length,
    error: input.error,
    groups: groupSessionsByRecency(visible, input.now).map((group) => ({
      id: group.id,
      label: `${sidebar.groups[group.id]} ${String(group.sessions.length)}`,
      sessions: group.sessions.map(toRow),
    })),
  };
}

export interface TopBarModelInput {
  title: string;
  modelLabel: string | null;
  connected: boolean;
  dict: Dictionary;
  theme: NativeShellTheme;
}

export function buildTopBarPayload({ title, modelLabel, connected, dict, theme }: TopBarModelInput): NativeTopBarPayload {
  return {
    title,
    modelLabel,
    connected,
    openSidebarLabel: dict.shell.titleBar.openSidebar,
    newConversationLabel: dict.shell.sidebar.newConversation,
    connectionLabel: connected ? dict.shell.titleBar.connected : dict.shell.titleBar.reconnecting,
    theme,
  };
}
