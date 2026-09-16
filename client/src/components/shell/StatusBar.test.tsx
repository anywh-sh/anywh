import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StatusBar } from "@/components/shell/StatusBar";
import { APP_VERSION } from "@/lib/appVersion";
import { defaultLocale } from "@/i18n/config";
import { en } from "@/i18n/en";
import type { Profile } from "@/lib/profiles";

const copy = en.shell.statusBar;
// The status bar's default locale context (no LocaleProvider in these
// tests) is `defaultLocale`, and the locale control prints its tag inline.
const versionAndLocale = `v${APP_VERSION}${defaultLocale}`;
const profile: Profile = { id: "p1", label: "Pessoal", host: "127.0.0.1", relayPort: 8765 };

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ repo: true, branch: "main", detached: false, changes: 3 })));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StatusBar", () => {
  it("always prints the running version, even with no session open", async () => {
    render(<StatusBar profile={null} sessionId={null} isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);

    expect(screen.getByText(`v${APP_VERSION}`)).toBeInTheDocument();
    // No session means nothing to ask the relay about — the bar must not
    // spawn a git process on the host just to render its own version.
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prints the branch and the change count of the focused session's folder", async () => {
    render(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);

    expect(await screen.findByText(`main · ${copy.changes.replace("{count}", "3")}`)).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/git/status?session=s1");
  });

  it("says a folder with no pending work is clean, not '0 changes'", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ repo: true, branch: "redesign/f8-status-bar", detached: false, changes: 0 }));
    render(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);

    expect(await screen.findByText(`redesign/f8-status-bar · ${copy.clean}`)).toBeInTheDocument();
  });

  it("reads a single change in the singular", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ repo: true, branch: "main", detached: false, changes: 1 }));
    render(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);

    expect(await screen.findByText(`main · ${copy.changesOne}`)).toBeInTheDocument();
  });

  it("explains a detached HEAD, whose left slot shows a commit and not a branch", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ repo: true, branch: "8a6732a", detached: true, changes: 0 }));
    render(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);

    const slot = await screen.findByText(`8a6732a · ${copy.clean}`);
    expect(slot).toHaveAttribute("title", copy.detachedHead);
  });

  it("shows nothing but the version and locale control when the folder is not a repository", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ repo: false }));
    const { container } = render(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(container.textContent?.trim()).toBe(versionAndLocale);
  });

  it("stays quiet when the relay can't be reached at all", async () => {
    // A profile whose machine is asleep is the normal case, not an error
    // worth a message in a strip the user can't dismiss.
    fetchMock.mockRejectedValue(new Error("connection refused"));
    const { container } = render(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(container.textContent?.trim()).toBe(versionAndLocale);
  });

  it("asks again when the turn ends and when the window comes back", async () => {
    const view = render(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // The agent is the main reason the count moves: a turn that just ended
    // is the single most likely moment for the folder to look different.
    view.rerender(<StatusBar profile={profile} sessionId="s1" isRunning windowFocused onOpenUpdateModal={() => {}} />);
    view.rerender(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    // The user is the other reason: committing in a terminal outside the app
    // is invisible here until the window is looked at again. Losing focus
    // asks nothing — a window nobody is looking at must not keep spawning
    // git processes on the host.
    view.rerender(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused={false} onOpenUpdateModal={() => {}} />);
    view.rerender(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  it("does not ask again on a re-render that changes nothing it depends on", async () => {
    // `App` re-renders this on every sidebar toggle and every tab switch;
    // each of those must not cost a git process on the host.
    const view = render(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    view.rerender(<StatusBar profile={{ ...profile }} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);
    view.rerender(<StatusBar profile={{ ...profile }} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the answer to a session the user already navigated away from", async () => {
    // Two tabs on different machines, switched fast: the first answer can
    // land after the second request was already made. Painting it would name
    // the wrong branch for the session on screen.
    const slow = new Promise<Response>((resolve) => {
      setTimeout(() => resolve(jsonResponse({ repo: true, branch: "stale", detached: false, changes: 9 })), 20);
    });
    fetchMock.mockReturnValueOnce(slow);
    fetchMock.mockResolvedValue(jsonResponse({ repo: true, branch: "current", detached: false, changes: 0 }));

    const view = render(<StatusBar profile={profile} sessionId="s1" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);
    view.rerender(<StatusBar profile={profile} sessionId="s2" isRunning={false} windowFocused onOpenUpdateModal={() => {}} />);

    expect(await screen.findByText(`current · ${copy.clean}`)).toBeInTheDocument();
    await slow;
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
  });
});
