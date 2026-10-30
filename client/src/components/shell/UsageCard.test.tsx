import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCALE_STORAGE_KEY, LocaleProvider } from "@/i18n";
import { groupByProfile, type ProfilePlanUsage } from "@/lib/planUsage/derive";
import type { RuntimePlanUsage } from "@/lib/planUsage/model";
import { setProfiles } from "@/lib/profiles/profiles";
import { UsageCard } from "./UsageCard";

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const MIN = 60_000;
const PROFILES = [
  { id: "pessoal", label: "Pessoal", host: "127.0.0.1", relayPort: 8001 },
  { id: "trabalho", label: "Trabalho", host: "127.0.0.1", relayPort: 8002 },
];
const label = (id: string) => PROFILES.find((profile) => profile.id === id)?.label ?? id;

function claude(five: number, seven: number, extra: Partial<RuntimePlanUsage> = {}): RuntimePlanUsage {
  return {
    runtime: "claude",
    status: "ok",
    windows: [
      { durationMins: 300, usedPercent: five, resetsAt: NOW + 72 * MIN },
      { durationMins: 10080, usedPercent: seven, resetsAt: NOW + 3 * 24 * 60 * MIN },
    ],
    plan: { family: "max", label: "Max 5x" },
    accountKey: "aaaa",
    observedAt: NOW,
    ...extra,
  };
}

const codexSignedOut: RuntimePlanUsage = { runtime: "codex", status: "signed_out", windows: [], observedAt: null };

function live(runtimes: RuntimePlanUsage[], extra: Partial<ProfilePlanUsage> = {}): ProfilePlanUsage {
  return { connection: "live", runtimes, observedAt: NOW, receivedAt: NOW - 12_000, refreshing: false, ...extra };
}

/** The card the way App mounts it: a Popover root, an anchor, a trigger. */
function Harness({ byProfile, onRefresh = () => undefined }: {
  byProfile: Record<string, ProfilePlanUsage>;
  onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <LocaleProvider>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Anchor>
          <PopoverPrimitive.Trigger>indicator</PopoverPrimitive.Trigger>
        </PopoverPrimitive.Anchor>
        <UsageCard
          groups={groupByProfile(["pessoal", "trabalho"], byProfile, "trabalho")}
          profileLabel={label}
          onRefresh={onRefresh}
        />
      </PopoverPrimitive.Root>
      <p>outside</p>
    </LocaleProvider>
  );
}

const trigger = () => screen.getByRole("button", { name: "indicator" });

function openCard(props: Parameters<typeof Harness>[0]) {
  const view = render(<Harness {...props} />);
  fireEvent.click(trigger());
  return { ...view, card: screen.getByRole("dialog") };
}

beforeEach(() => {
  setProfiles(PROFILES);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe("UsageCard", () => {
  it("is a labelled dialog on the left edge: top and right border, no shadow, a short rise", () => {
    const { card } = openCard({ byProfile: { trabalho: live([claude(58, 41)]) } });
    expect(card).toHaveAccessibleName("Usage");
    expect(card.className).toContain("w-[420px]");
    const classes = card.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["border-t", "border-r"]));
    expect(classes).not.toContain("border-l");
    // Above the bar, aligned to its start: the window's left edge.
    expect(card).toHaveAttribute("data-side", "top");
    expect(card).toHaveAttribute("data-align", "start");
    expect(classes.filter((name) => name === "border" || name.startsWith("shadow"))).toEqual([]);
    expect(card.className).toContain("animate-usage-card-in");
  });

  it("heads with the counts, the age of the freshest reading and a refresh button", () => {
    const onRefresh = vi.fn();
    const { card } = openCard({ byProfile: { pessoal: live([claude(10, 10, { accountKey: "bbbb" })]), trabalho: live([claude(58, 41), codexSignedOut]) }, onRefresh });
    const header = card.querySelector("header")!;
    expect(header).toHaveTextContent("Usage2 profiles · 2 accounts12s ago");
    fireEvent.click(within(header).getByRole("button", { name: "Refresh usage" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(3000));
    expect(header).toHaveTextContent("15s ago");
  });

  it("never spins for a sent refresh, only for a read the relay reports", () => {
    const onRefresh = vi.fn();
    const { card } = openCard({ byProfile: { trabalho: live([claude(58, 41)]) }, onRefresh });
    const refresh = within(card).getByRole("button", { name: "Refresh usage" });
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveAttribute("aria-busy", "false");
    expect(refresh.querySelector("svg")?.getAttribute("class")).not.toContain("animate-spin");
  });

  it("takes a burst of clicks as one", () => {
    const onRefresh = vi.fn();
    const { card } = openCard({ byProfile: { trabalho: live([claude(58, 41)]) }, onRefresh });
    const refresh = within(card).getByRole("button", { name: "Refresh usage" });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("holds the button while every relay would answer from its cache, and says until when", () => {
    const onRefresh = vi.fn();
    // The relay's clock runs 12s ahead of this one (observedAt NOW, received
    // at NOW - 12s): its refreshableAt NOW + 60s is NOW + 48s here.
    const { card } = openCard({
      byProfile: { trabalho: live([{ ...claude(58, 41), refreshableAt: NOW + 60_000 }, { ...claude(10, 10, { runtime: "codex", accountKey: "c" }), refreshableAt: NOW + 30_000 }]) },
      onRefresh,
    });
    const refresh = within(card).getByRole("button", { name: "Refresh usage" });
    expect(refresh).toHaveAttribute("aria-disabled", "true");
    expect(card.querySelector("[data-usage-age]")).toHaveTextContent("12s ago · again in 18s");
    expect(refresh).toHaveAttribute("title", "12s ago · again in 18s");
    fireEvent.click(refresh);
    expect(onRefresh).not.toHaveBeenCalled();

    // Free as soon as the first runtime is past its own floor.
    act(() => vi.advanceTimersByTime(18_000));
    expect(refresh).toHaveAttribute("aria-disabled", "false");
    expect(card.querySelector("[data-usage-age]")).toHaveTextContent(/^30s ago$/);
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("is free when any runtime has no floor running", () => {
    const { card } = openCard({ byProfile: { trabalho: live([{ ...claude(58, 41), refreshableAt: NOW + 60_000 }, claude(10, 10, { runtime: "codex", accountKey: "c" })]) } });
    expect(within(card).getByRole("button", { name: "Refresh usage" })).toHaveAttribute("aria-disabled", "false");
  });

  it("stays busy while a read is really running, not only until the relay answers", () => {
    const { card } = openCard({ byProfile: { trabalho: live([{ ...claude(58, 41), reading: true, readingSince: NOW }]) } });
    const refresh = within(card).getByRole("button", { name: "Refresh usage" });
    expect(refresh).toHaveAttribute("aria-busy", "true");
    expect(refresh.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
    const account = within(card).getByRole("region", { name: "Claude Code" });
    expect(account.querySelector("[data-usage-account-reading]")).toHaveTextContent("updating…");
    // The flag is dropped once it has gone unanswered too long.
    act(() => vi.advanceTimersByTime(46_000));
    expect(refresh).toHaveAttribute("aria-busy", "false");
  });

  it("says why an account has no numbers", () => {
    const unknown: RuntimePlanUsage = { runtime: "claude", status: "unknown", windows: [], observedAt: null };
    const { card } = openCard({
      byProfile: {
        trabalho: live([unknown, { runtime: "codex", status: "error", windows: [], observedAt: null, error: { kind: "auth" } }]),
        pessoal: live([{ ...unknown, accountKey: "zz", reading: true }]),
      },
    });
    const notes = Array.from(card.querySelectorAll<HTMLElement>("[data-usage-note]")).map((note) => [note.dataset.usageNote, note.textContent, note.title]);
    expect(notes).toEqual([
      ["notRead", "not read yet · refresh to read", ""],
      ["errorAuth", "read failed", "login rejected"],
      ["reading", "updating…", ""],
    ]);
  });

  it("lists the active tab's profile first, marked, then the others", () => {
    const { card } = openCard({ byProfile: { pessoal: live([claude(10, 10, { accountKey: "bbbb" })]), trabalho: live([claude(58, 41)]) } });
    const sections = Array.from(card.querySelectorAll<HTMLElement>("[data-usage-profile]"));
    expect(sections.map((section) => section.dataset.usageProfile)).toEqual(["trabalho", "pessoal"]);
    expect(sections[0]).toHaveTextContent(/^Trabalhoactive tab/);
    expect(sections[1]).not.toHaveTextContent("active tab");
  });

  it("draws an account with its plan, a meter per window, the percentage and the renewal", () => {
    const { card } = openCard({ byProfile: { trabalho: live([claude(58, 41)]) } });
    const account = within(card).getByRole("region", { name: "Claude Code" });
    expect(account).toHaveTextContent(/^Claude CodeMax 5x/);
    const mark = account.querySelector('[data-agent-mark="claude"]')!;
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark.querySelector("svg")?.getAttribute("class")).toContain("size-[18px]");
    const meters = within(account).getAllByRole("meter");
    expect(meters.map((meter) => meter.getAttribute("aria-label"))).toEqual(["5h: 58% used", "7d: 41% used"]);
    // The pace mark only for the eye; its value in the meter's text.
    expect(meters[0].getAttribute("aria-valuetext")).toMatch(/^58% used, \d+% expected$/);
    expect(meters[1].querySelectorAll('[data-part="cut"]')).toHaveLength(6);
    const five = account.querySelector<HTMLElement>('[data-usage-window="5h"]')!;
    expect(five).toHaveTextContent("58%↻ 1h 12mrenews in 1h 12m");
    const seven = account.querySelector<HTMLElement>('[data-usage-window="7d"]')!;
    expect(seven).toHaveTextContent(/41%↻ \S+ .+renews \S+ /);
    expect(account).not.toHaveTextContent("@");
  });

  it("marks a spent account and says when the window comes back", () => {
    const { card } = openCard({ byProfile: { trabalho: live([claude(100, 64)]) } });
    const account = within(card).getByRole("region", { name: "Claude Code" });
    expect(within(account).getByText("limit reached").className).toContain("text-err");
    const five = account.querySelector<HTMLElement>('[data-usage-window="5h"]')!;
    expect(within(five).getByText("back in 1h 12m").className).toContain("text-err");
    expect(within(five).getByRole("meter").querySelector('[data-part="pace"]')).toBeNull();
  });

  it("shows a repeated account once, then as a line pointing at it", () => {
    const { card } = openCard({ byProfile: { pessoal: live([claude(52, 37)]), trabalho: live([claude(52, 37)]) } });
    const repeat = card.querySelector<HTMLElement>('[data-usage-profile="pessoal"] [data-same-account="trabalho"]')!;
    expect(repeat).toHaveTextContent("Claude Codesame account as Trabalho52% · 37%");
    expect(within(repeat).queryAllByRole("meter")).toHaveLength(0);
  });

  it("offers the login command for an agent with no login, and says when it was copied", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { card } = openCard({ byProfile: { trabalho: live([{ ...codexSignedOut, runtime: "claude" }, codexSignedOut]) } });
    const strips = Array.from(card.querySelectorAll<HTMLElement>("[data-usage-signed-out]"));
    expect(strips.map((strip) => strip.querySelector("code")?.textContent)).toEqual(["claude auth login", "codex login"]);
    expect(strips[0].querySelector(".bg-primary")).not.toBeNull();

    await act(async () => {
      fireEvent.click(within(strips[1]).getByRole("button", { name: "Copy codex login" }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("codex login");
    expect(within(strips[1]).getByRole("status")).toHaveTextContent("Copied");
    expect(within(strips[1]).getByRole("button")).toHaveTextContent("Copied");
    act(() => vi.advanceTimersByTime(1500));
    expect(within(strips[1]).getByRole("button")).toHaveTextContent("Copy");
  });

  it("shows an agent never signed in on this profile as one quiet line, with its command and Copy", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { card } = openCard({ byProfile: { trabalho: live([claude(58, 41), { ...codexSignedOut, everSignedIn: false }]) } });
    expect(card.querySelector("[data-usage-signed-out]")).toBeNull();
    const line = card.querySelector<HTMLElement>("[data-usage-not-used]")!;
    expect(line).toHaveTextContent("Codex·not used on this profile·codex loginCopy");
    expect(line.querySelector(".bg-primary")).toBeNull();
    await act(async () => {
      fireEvent.click(within(line).getByRole("button", { name: "Copy codex login" }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("codex login");
    expect(within(line).getByRole("status")).toHaveTextContent("Copied");
    // Still one account (only Claude has one), still in the card.
    expect(card.querySelector("header")).toHaveTextContent("2 profiles · 1 account");
  });

  it("keeps an unreachable profile's last numbers, dimmed and dated", () => {
    const { card } = openCard({
      byProfile: { trabalho: live([claude(10, 10)]), pessoal: live([claude(70, 20, { accountKey: "bbbb" })], { connection: "offline", receivedAt: NOW - 12 * MIN }) },
    });
    const section = card.querySelector<HTMLElement>('[data-usage-profile="pessoal"]')!;
    expect(section).toHaveAttribute("data-state", "stale");
    expect(section).toHaveTextContent("offline · 12m ago");
    expect(section.querySelector(".opacity-60")).not.toBeNull();
    expect(within(section).getAllByRole("meter")).toHaveLength(2);
  });

  it("says what is missing for a profile with nothing to show", () => {
    const { card } = openCard({ byProfile: { trabalho: { ...live([]), connection: "unsupported", runtimes: null }, pessoal: { ...live([]), connection: "offline", runtimes: null } } });
    expect(card.querySelector('[data-usage-profile="trabalho"]')).toHaveTextContent("relay too old for usage");
    expect(card.querySelector('[data-usage-profile="pessoal"]')).toHaveTextContent("offline");
  });

  it("ends with the pace legend", () => {
    const { card } = openCard({ byProfile: { trabalho: live([claude(58, 41)]) } });
    expect(card.querySelector("footer")).toHaveTextContent("expected pace for now");
  });

  it("closes on Escape, a click outside and a second click on the indicator, focus back on it", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<Harness byProfile={{ trabalho: live([claude(58, 41)]) }} />);

    await user.click(trigger());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger()).toHaveFocus();

    await user.click(trigger());
    await screen.findByRole("dialog");
    await user.click(trigger());
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(trigger());
    await screen.findByRole("dialog");
    await user.click(screen.getByText("outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("speaks Portuguese", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "pt-BR");
    const { card } = openCard({ byProfile: { trabalho: live([claude(100, 41)]), pessoal: live([claude(100, 41)]) } });
    expect(card).toHaveAccessibleName("Uso");
    expect(card).toHaveTextContent("aba ativa");
    expect(card).toHaveTextContent("volta em 1h 12m");
    expect(card).toHaveTextContent("mesma conta de Trabalho");
    expect(card).toHaveTextContent("ritmo esperado para agora");
  });
});
