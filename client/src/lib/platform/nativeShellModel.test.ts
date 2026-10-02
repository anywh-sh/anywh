import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import type { MergedSession } from "@/lib/format/sessionGrouping";
import type { Profile } from "@/lib/profiles/profiles";
import { buildDrawerPayload, buildShellTheme, buildTopBarPayload } from "./nativeShellModel";

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
const theme = buildShellTheme(() => "#112233");
const profile = (id: string, label: string): Profile => ({ id, label, host: "h", relayPort: 1 });
const session = (id: string, profileId: string, minutesAgo: number | null): MergedSession =>
  ({ id, profileId, title: `title ${id}`, lastActiveAt: minutesAgo === null ? null : NOW - minutesAgo * 60_000 });

describe("buildShellTheme", () => {
  it("resolves every slot from its CSS variable, including the ink on primary", () => {
    const seen: string[] = [];
    const built = buildShellTheme((css) => {
      seen.push(css);
      return css;
    });
    expect(built.primary).toBe("var(--primary)");
    expect(built.primaryForeground).toBe("var(--primary-foreground)");
    expect(seen).toHaveLength(Object.keys(built).length);
  });
});

function build(over: Partial<Parameters<typeof buildDrawerPayload>[0]> = {}) {
  return buildDrawerPayload({
    sessions: [],
    profiles: [profile("a", "Personal")],
    activeProfileId: "a",
    selectedSessionId: null,
    running: new Set(),
    backgroundJobSessions: new Set(),
    loading: false,
    error: false,
    dict: en,
    locale: "en",
    theme,
    profileCssColor: (id) => `var(--${id})`,
    resolve: (css) => `resolved(${css})`,
    now: NOW,
    ...over,
  });
}

describe("buildDrawerPayload", () => {
  it("groups by recency and puts the count in the heading", () => {
    const payload = build({ sessions: [session("1", "a", 5), session("2", "a", 10), session("3", "a", 60 * 24 * 3)] });
    expect(payload.groups.map((g) => g.id)).toEqual(["today", "week"]);
    expect(payload.groups[0].label).toBe(`${en.shell.sidebar.groups.today} 2`);
    expect(payload.groups[0].sessions.map((s) => s.id)).toEqual(["1", "2"]);
  });

  it("never puts the profile name in the meta line", () => {
    const payload = build({ sessions: [session("1", "a", 5)], profiles: [profile("a", "Personal"), profile("b", "Work")] });
    expect(payload.groups[0].sessions[0].meta).not.toContain("Personal");
  });

  it("lists only the active profile's sessions", () => {
    const payload = build({
      sessions: [session("1", "a", 5), session("2", "b", 6), session("3", "a", 7)],
      profiles: [profile("a", "Personal"), profile("b", "Work")],
      activeProfileId: "b",
    });
    expect(payload.groups.flatMap((g) => g.sessions.map((s) => s.id))).toEqual(["2"]);
    expect(payload.hasMore).toBe(false);
  });

  it("caps the list at the latest ten and flags the rest", () => {
    const sessions = Array.from({ length: 12 }, (_, i) => session(String(i), "a", i + 1));
    const payload = build({ sessions });
    const ids = payload.groups.flatMap((g) => g.sessions.map((s) => s.id));
    expect(ids).toEqual(sessions.slice(0, 10).map((s) => s.id));
    expect(payload.hasMore).toBe(true);
    expect(build({ sessions: sessions.slice(0, 10) }).hasMore).toBe(false);
  });

  it("leaves the time out when the session has no timestamp", () => {
    const payload = build({ sessions: [session("1", "a", null)] });
    expect(payload.groups[0].sessions[0].meta).toBe("");
  });

  it("shows at most one indicator, running first", () => {
    const payload = build({
      sessions: [session("1", "a", 5), session("2", "a", 6)],
      running: new Set(["1"]),
      backgroundJobSessions: new Set(["1", "2"]),
    });
    const [first, second] = payload.groups[0].sessions;
    expect(first).toMatchObject({ running: true, backgroundJob: false });
    expect(second).toMatchObject({ running: false, backgroundJob: true });
  });

  it("marks the selected row and resolves the profile color", () => {
    const payload = build({ sessions: [session("1", "a", 5), session("2", "a", 6)], selectedSessionId: "2" });
    expect(payload.groups[0].sessions.map((s) => s.selected)).toEqual([false, true]);
    expect(payload.groups[0].sessions[0].color).toBe("resolved(var(--a))");
  });

  it("only reports loading while there is nothing to show", () => {
    expect(build({ loading: true }).loading).toBe(true);
    expect(build({ loading: true, sessions: [session("1", "a", 5)] }).loading).toBe(false);
  });

  it("carries the error flag and the localized strings", () => {
    const payload = build({ error: true });
    expect(payload.error).toBe(true);
    expect(payload.strings.retry).toBe(en.common.retry);
    expect(payload.strings.deleteBody).toBe(en.shell.sidebar.sessionMenu.deleteBody);
  });
});

describe("buildTopBarPayload", () => {
  it("labels the dot by connection state", () => {
    expect(buildTopBarPayload({ title: "t", modelLabel: "Opus", connected: true, dict: en, theme }).connectionLabel).toBe(en.shell.titleBar.connected);
    expect(buildTopBarPayload({ title: "t", modelLabel: null, connected: false, dict: en, theme }).connectionLabel).toBe(en.shell.titleBar.reconnecting);
  });
});
