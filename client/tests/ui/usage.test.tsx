import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { setProfiles } from "@/lib/profiles/profiles";
import type { RuntimePlanUsage } from "@/lib/planUsage/model";

// Same Tauri shims as panelToggles.test.tsx.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => [] }));

const HOUR = 3_600_000;

function claude(usedPercent: number, accountKey: string): RuntimePlanUsage {
  return {
    runtime: "claude",
    status: "ok",
    windows: [{ durationMins: 300, usedPercent, resetsAt: Date.now() + 2 * HOUR }],
    observedAt: Date.now(),
    accountKey,
  };
}

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  setProfiles([
    { id: "pessoal", label: "Pessoal", host: "127.0.0.1", relayPort: 8001 },
    { id: "trabalho", label: "Trabalho", host: "127.0.0.1", relayPort: 8002 },
  ]);
  relay = installFakeRelay("fake reply", {
    planUsage: {
      "127.0.0.1:8001": { runtimes: [claude(58, "aaaa")], readMs: 400 },
      "127.0.0.1:8002": { runtimes: [claude(91, "bbbb")] },
    },
  });
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

describe("plan usage in the status bar", () => {
  it("shows the active profile's agents, the other one only in the card, and re-reads on open", async () => {
    const user = userEvent.setup();
    renderApp();

    const statusBar = document.querySelector<HTMLElement>("[data-status-bar]")!;
    const indicator = await within(statusBar).findByRole("button", { name: /^Usage: / });
    // Both profiles are watched, whichever tab is active.
    expect(relay.sockets.filter((socket) => socket.url.includes("/plan-usage/watch")).map((socket) => socket.url).sort()).toEqual([
      "ws://127.0.0.1:8001/plan-usage/watch",
      "ws://127.0.0.1:8002/plan-usage/watch",
    ]);
    // The other profile's 91% is not in the status bar (no alert there, the
    // owner's call); the card below shows it.
    expect(indicator).toHaveAccessibleName("Usage: Claude Code 58% 5h");
    // The bar's first item, on the left (a deliberate change from the
    // design's right-hand placement); the relay status stays on the right.
    expect(statusBar.firstElementChild?.contains(indicator)).toBe(true);
    const relayStatus = within(statusBar).getByRole("status");
    expect(indicator.compareDocumentPosition(relayStatus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(indicator).getByRole("meter")).toHaveAttribute("aria-valuenow", "58");

    await user.click(indicator);
    expect(screen.getByRole("button", { name: /^Usage: / })).toHaveAttribute("aria-expanded", "true");
    const card = await screen.findByRole("dialog", { name: "Usage" });
    // The active tab's profile first; the other one's 91% is right there too.
    expect(Array.from(card.querySelectorAll<HTMLElement>("[data-usage-profile]")).map((section) => section.dataset.usageProfile)).toEqual([
      "pessoal",
      "trabalho",
    ]);
    expect(within(card.querySelector<HTMLElement>('[data-usage-profile="trabalho"]')!).getByRole("meter")).toHaveAttribute("aria-valuenow", "91");
    expect(
      relay.sent
        .filter((entry) => entry.message.type === "plan_usage_refresh")
        .map((entry) => [entry.url, entry.message.force])
        .sort(),
    ).toEqual([
      ["ws://127.0.0.1:8001/plan-usage/watch", false],
      ["ws://127.0.0.1:8002/plan-usage/watch", false],
    ]);

    // The refresh button forces a read on every relay, and spins until both answer.
    // Opening the card started a read of its own; the button waits it out.
    await vi.waitFor(() => expect(within(card).getByRole("button", { name: "Refresh usage" })).toHaveAttribute("aria-busy", "false"));
    relay.sent.length = 0;
    await user.click(within(card).getByRole("button", { name: "Refresh usage" }));
    expect(relay.sent.filter((entry) => entry.message.type === "plan_usage_refresh").map((entry) => [entry.url, entry.message]).sort()).toEqual([
      ["ws://127.0.0.1:8001/plan-usage/watch", { type: "plan_usage_refresh", force: true }],
      ["ws://127.0.0.1:8002/plan-usage/watch", { type: "plan_usage_refresh", force: true }],
    ]);
    // Busy for as long as the relay says the read runs, with the status bar
    // saying so too — not only until the relay acknowledged the click.
    await vi.waitFor(() => expect(document.querySelector('[data-usage-agent="claude"] [data-usage-reading]')).not.toBeNull());
    expect(within(card).getByRole("button", { name: "Refresh usage" })).toHaveAttribute("aria-busy", "true");
    await vi.waitFor(() => expect(within(card).getByRole("button", { name: "Refresh usage" })).toHaveAttribute("aria-busy", "false"));
    expect(document.querySelector('[data-usage-agent="claude"] [data-usage-reading]')).toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /^Usage: / })).toHaveFocus();
  });

  it("holds refresh while the relay would only answer from its cache, and opens the card with one cheap re-read", async () => {
    relay.uninstall();
    relay = installFakeRelay("fake reply", {
      planUsage: {
        "127.0.0.1:8001": { runtimes: [claude(58, "aaaa")], cooldownMs: 60_000 },
        "127.0.0.1:8002": { runtimes: [claude(20, "bbbb")], cooldownMs: 60_000 },
      },
    });
    const user = userEvent.setup();
    renderApp();
    const statusBar = document.querySelector<HTMLElement>("[data-status-bar]")!;
    const indicator = await within(statusBar).findByRole("button", { name: /^Usage: / });
    const refreshesSent = () => relay.sent.filter((entry) => entry.message.type === "plan_usage_refresh").map((entry) => entry.message.force);

    await user.click(indicator);
    const card = await screen.findByRole("dialog", { name: "Usage" });
    expect(refreshesSent()).toEqual([false, false]);
    const refresh = () => within(card).getByRole("button", { name: "Refresh usage" });

    await user.click(refresh());
    expect(refreshesSent()).toEqual([false, false, true, true]);
    // Both relays read and started their floor: held, and saying until when.
    await vi.waitFor(() => expect(refresh()).toHaveAttribute("aria-disabled", "true"));
    expect(card.querySelector("[data-usage-age]")?.textContent).toMatch(/^now · again in (1m 00s|\d+s)$/);
    expect(refresh()).toHaveAttribute("aria-busy", "false");

    // More clicks while held: nothing sent.
    await user.click(refresh());
    await user.click(refresh());
    expect(refreshesSent()).toEqual([false, false, true, true]);
    expect(relay.forcedRefreshes()).toEqual({ received: 2, read: 2 });

    // Closing and opening again: one cheap re-read per opening.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /^Usage: / }));
    await screen.findByRole("dialog", { name: "Usage" });
    expect(refreshesSent()).toEqual([false, false, true, true, false, false]);
  });
});
