import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocaleProvider } from "@/i18n";
import App from "@/App";
import { installFakeRelay, type FakeRelay } from "../ui/helpers/fakeRelay";
import { en } from "@/i18n/en";
import { seedShellProfile } from "../ui/helpers/seedProfile";

/**
 * Render-cost baseline for the interactions a user performs constantly:
 * opening a conversation, switching tabs, collapsing the sidebar.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT. This runs under happy-dom, which
 * has no layout engine — no layout, no paint, no compositing happens here.
 * What it captures is the work the app itself does: how many commits an
 * interaction costs, how much time React spends rendering them, and how many
 * DOM nodes the app holds. Those are the numbers that move when a redesign
 * makes the session list build five nodes per row instead of two, or makes
 * collapsing the sidebar re-render every mounted conversation. Anything about
 * frames — a transition on `width`, a repaint from `box-shadow`, a dropped
 * frame while dragging — is invisible here by construction and has to be
 * measured in the real app with the browser's own profiler.
 *
 * Timing comes from React's `<Profiler>` (`actualDuration`), not from a clock
 * around the interaction: wall-clock time here is dominated by user-event's
 * own event sequencing and by `waitFor`'s polling interval, which reported
 * ~120ms for a tab switch that costs the app a fraction of that. Commit counts
 * and node counts are exact and repeat run to run; the millisecond figures
 * still carry GC and scheduling noise, so treat a change under ~20% as
 * indistinguishable and compare the counts first.
 *
 * Deliberately NOT part of `npm test`: the `.perf.tsx` suffix doesn't match
 * vitest's default `*.test.*`/`*.spec.*` include, so only
 * `vitest.perf.config.ts` (i.e. `npm run perf`) picks it up. It prints a
 * report rather than guarding a threshold — timing assertions on shared
 * runners are how a suite becomes flaky. Run it before and after a change that
 * reshapes the UI.
 */

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

const COMPOSER = en.chat.composer.placeholder;

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  // Without a profile the app shows the first-run screen, not the shell.
  seedShellProfile();
  relay = installFakeRelay("perf reply");
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

/** One entry per commit React performs on the tree. `actualDuration` is the
 * time spent rendering the committed subtree — the app's own cost, with the
 * harness's event simulation excluded. */
let commitDurations: number[] = [];

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  commitDurations.push(actualDuration);
};

/** Mirrors tests/ui/helpers/renderApp.tsx (TooltipProvider is required —
 * `<App />` alone throws) with the profiler wrapped around the app. */
function renderProfiledApp() {
  return render(
    <LocaleProvider>
      <TooltipProvider>
        <Profiler id="app" onRender={onRender}>
          <App />
        </Profiler>
      </TooltipProvider>
    </LocaleProvider>,
  );
}

function domNodes(): number {
  return document.querySelectorAll("*").length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

const report: Record<string, number> = {};

function record(metric: string, value: number): void {
  report[metric] = Math.round(value * 100) / 100;
}

function recordCommits(metric: string): void {
  record(`${metric}.renderMs`, sum(commitDurations));
  record(`${metric}.commits`, commitDurations.length);
}

/**
 * Runs `action` once as a discarded warm-up — it pays for lazily-compiled
 * paths and first-touch allocation no later interaction pays again — then
 * `repeats` more times, reporting the median of the per-repetition totals.
 */
async function measureRepeated(
  metric: string,
  repeats: number,
  action: (iteration: number) => Promise<void>,
): Promise<void> {
  await action(0);
  const durations: number[] = [];
  const counts: number[] = [];
  for (let index = 1; index <= repeats; index++) {
    commitDurations = [];
    await action(index);
    durations.push(sum(commitDurations));
    counts.push(commitDurations.length);
  }
  record(`${metric}.renderMs`, median(durations));
  record(`${metric}.commits`, median(counts));
}

async function openNewConversation(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const before = screen.queryAllByLabelText(COMPOSER).length;
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  await vi.waitFor(() => expect(screen.getAllByLabelText(COMPOSER)).toHaveLength(before + 1));
}

describe("interaction baseline", () => {
  it("measures mount, opening a conversation, tab switching and sidebar collapse", async () => {
    // `delay: null` drops user-event's artificial pause between the pointer
    // events of one click — it isn't part of what the app costs.
    const user = userEvent.setup({ delay: null });

    // The app boots with no session open: shell only (title bar, sidebar, idle
    // screen), which is what a cold launch actually renders.
    commitDurations = [];
    renderProfiledApp();
    await screen.findByRole("button", { name: en.shell.sidebar.newConversation });
    recordCommits("mount");
    record("mount.domNodes", domNodes());

    commitDurations = [];
    await openNewConversation(user);
    recordCommits("firstConversation");
    record("firstConversation.domNodes", domNodes());

    // Three more (one warm-up + two measured), for four tabs total: enough for
    // "switching" to mean something, and enough that a re-render which isn't
    // scoped to the active tab shows up as a multiple rather than as noise.
    await measureRepeated("laterConversation", 2, () => openNewConversation(user));
    const tabCount = screen.getAllByRole("tab").length;
    record("openTabs", tabCount);
    record("openTabs.domNodes", domNodes());

    await measureRepeated("tabSwitch", 6, async (iteration) => {
      await user.click(screen.getAllByRole("tab")[iteration % tabCount]);
    });

    // The label flips between collapse and expand on each press, so it can't
    // be resolved once outside the loop.
    const sidebarToggleName = new RegExp(
      `${en.shell.titleBar.collapseSidebar}|${en.shell.titleBar.expandSidebar}`,
      "i",
    );
    await measureRepeated("sidebarToggle", 6, async () => {
      await user.click(screen.getByRole("button", { name: sidebarToggleName }));
    });

    const width = Math.max(...Object.keys(report).map((key) => key.length));
    const lines = Object.entries(report).map(([key, value]) => `  ${key.padEnd(width)}  ${value}`);
    console.log(["", "[perf] interaction baseline", ...lines, ""].join("\n"));

    // The only assertions are sanity checks on the harness itself: if the app
    // failed to mount, every number above would be meaningless rather than
    // merely different.
    expect(report["mount.domNodes"]).toBeGreaterThan(50);
    expect(report["openTabs.domNodes"]).toBeGreaterThan(report["mount.domNodes"]);
  }, 60_000);
});
