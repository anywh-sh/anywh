import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCALE_STORAGE_KEY, LocaleProvider } from "@/i18n";
import type { ProfilePlanUsage } from "@/lib/planUsage/derive";
import type { RuntimePlanUsage } from "@/lib/planUsage/model";
import { setProfiles } from "@/lib/profiles/profiles";
import { AgentLogo } from "@/components/chat/AgentLogo";
import { UsageIndicator } from "./UsageIndicator";

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const MIN = 60_000;
const PROFILES = [
  { id: "pessoal", label: "Pessoal", host: "127.0.0.1", relayPort: 8001 },
  { id: "trabalho", label: "Trabalho", host: "127.0.0.1", relayPort: 8002 },
];

function claude(five: number, seven = 41, extra: Partial<RuntimePlanUsage> = {}): RuntimePlanUsage {
  return {
    runtime: "claude",
    status: "ok",
    windows: [
      { durationMins: 300, usedPercent: five, resetsAt: NOW + 58 * MIN },
      { durationMins: 10080, usedPercent: seven, resetsAt: NOW + 3 * 24 * 60 * MIN },
    ],
    observedAt: NOW,
    ...extra,
  };
}

const codexFree = (used: number): RuntimePlanUsage => ({
  runtime: "codex",
  status: "ok",
  windows: [{ durationMins: 43200, usedPercent: used, resetsAt: NOW + 10 * 24 * 60 * MIN, limitId: "codex" }],
  observedAt: NOW,
});

function live(runtimes: RuntimePlanUsage[], extra: Partial<ProfilePlanUsage> = {}): ProfilePlanUsage {
  return { connection: "live", runtimes, observedAt: NOW, receivedAt: NOW, refreshing: false, ...extra };
}

function renderIndicator(byProfile: Record<string, ProfilePlanUsage>, props: { expanded?: boolean; onClick?: () => void } = {}) {
  return render(
    <LocaleProvider>
      <UsageIndicator
        profileId="pessoal"
        profiles={PROFILES}
        byProfile={byProfile}
        now={NOW}
        expanded={props.expanded ?? false}
        onClick={props.onClick}
      />
    </LocaleProvider>,
  );
}

const button = () => screen.getByRole("button");
const agent = (runtime: string) => document.querySelector<HTMLElement>(`[data-usage-agent="${runtime}"]`)!;

function stubWidth(width: number) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: width <= Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Number.NaN),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

beforeEach(() => {
  setProfiles(PROFILES);
  stubWidth(1440);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("UsageIndicator", () => {
  it("is one button that announces a dialog and summarizes every agent", () => {
    renderIndicator({ pessoal: live([claude(58), codexFree(37)]) });
    expect(button()).toHaveAttribute("aria-haspopup", "dialog");
    expect(button()).toHaveAttribute("aria-expanded", "false");
    expect(button()).toHaveAccessibleName("Usage: Claude Code 58% 5h; Codex 37% 30d");
    expect(agent("claude")).toHaveTextContent(/^58% 5h · 41% 7d$/);
    expect(agent("codex")).toHaveTextContent(/^37% 30d$/);
  });

  it("draws each agent's product logo at 15px, hidden from assistive tech", () => {
    renderIndicator({ pessoal: live([claude(58), codexFree(37)]) });
    for (const runtime of ["claude", "codex"]) {
      const mark = agent(runtime).querySelector(`[data-agent-mark="${runtime}"]`)!;
      expect(mark).toHaveAttribute("aria-hidden", "true");
      expect(mark.querySelector("svg")?.getAttribute("class")).toContain("size-[15px]");
    }
    // The same mark the room's agent cards draw.
    const { container } = render(<AgentLogo agentId="codex" className="size-[15px]" />);
    expect(agent("codex").querySelector("svg")?.outerHTML).toBe(container.querySelector("svg")?.outerHTML);
  });

  it("draws one meter per agent, for its most used window", () => {
    renderIndicator({ pessoal: live([claude(20, 70), codexFree(37)]) });
    const meters = within(button()).getAllByRole("meter");
    expect(meters.map((meter) => meter.getAttribute("aria-label"))).toEqual(["7d: 70% used", "30d: 37% used"]);
    expect(meters.every((meter) => meter.className.includes("w-[28px]") && meter.className.includes("h-[3px]"))).toBe(true);
  });

  it("raises the number to the warning tone from 80%", () => {
    renderIndicator({ pessoal: live([claude(85)]) });
    const number = within(agent("claude")).getByText("85% 5h");
    expect(number.className).toContain("text-warn");
    expect(number.className).toContain("font-medium");
    expect(within(button()).getByRole("meter")).toHaveAttribute("data-level", "warn");
  });

  it("says when a spent agent comes back, in text, in the stop tone", () => {
    renderIndicator({ pessoal: live([claude(100)]) });
    const reset = within(agent("claude")).getByText("back in 58m");
    expect(reset.className).toContain("text-err");
    expect(button()).toHaveAccessibleName("Usage: Claude Code limit reached, back in 58m");
  });

  it("shows a missing login with the accent dot, and an API key as a chip", () => {
    renderIndicator({
      pessoal: live([
        { runtime: "claude", status: "no_subscription", windows: [], observedAt: NOW },
        { runtime: "codex", status: "signed_out", windows: [], observedAt: NOW },
      ]),
    });
    expect(agent("claude")).toHaveTextContent("API key");
    expect(agent("codex")).toHaveTextContent("not signed in");
    expect(agent("codex").querySelector(".bg-primary")).not.toBeNull();
    expect(button()).toHaveAccessibleName("Usage: Claude Code API key; Codex not signed in");
  });

  it("says why there is nothing: never read, or the cause of a failed read", () => {
    renderIndicator({
      pessoal: live([
        { runtime: "claude", status: "unknown", windows: [], observedAt: null },
        { runtime: "codex", status: "error", windows: [], observedAt: null, error: { kind: "network" } },
      ]),
    });
    expect(agent("claude")).toHaveTextContent("not read yet");
    expect(agent("codex")).toHaveTextContent("network error");
    expect(button()).toHaveAccessibleName("Usage: Claude Code not read yet; Codex network error");
  });

  it("shows a read in progress instead of 'not read yet', without pulsing", () => {
    renderIndicator({ pessoal: live([{ runtime: "claude", status: "unknown", windows: [], observedAt: null, reading: true, readingSince: NOW }]) });
    expect(agent("claude")).toHaveTextContent("updating…");
    expect(agent("claude")).not.toHaveTextContent("not read yet");
    const mark = agent("claude").querySelector("[data-usage-reading]")!;
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark.className).toContain("animate-spin");
    expect(mark.className).not.toContain("animate-pulse");
    expect(button()).toHaveAccessibleName("Usage: Claude Code updating…");
  });

  it("keeps the numbers while they are being refreshed, and says so", () => {
    renderIndicator({ pessoal: live([{ ...claude(58), reading: true, readingSince: NOW }]) });
    expect(agent("claude")).toHaveTextContent("58% 5h");
    expect(agent("claude").querySelector("[data-usage-reading]")).not.toBeNull();
    expect(button()).toHaveAccessibleName("Usage: Claude Code 58% 5h, updating…");
  });

  it("stops believing a read whose end never arrived, and never reads on an unreachable relay", () => {
    const { rerender } = renderIndicator({
      pessoal: live([{ runtime: "claude", status: "unknown", windows: [], observedAt: null, reading: true }], { receivedAt: NOW - 46_000 }),
    });
    expect(agent("claude")).toHaveTextContent("not read yet");
    rerender(
      <LocaleProvider>
        <UsageIndicator
          profileId="pessoal"
          profiles={PROFILES}
          byProfile={{ pessoal: live([{ ...claude(58), reading: true }], { connection: "offline" }) }}
          now={NOW}
          expanded={false}
        />
      </LocaleProvider>,
    );
    expect(agent("claude").querySelector("[data-usage-reading]")).toBeNull();
  });

  it("keeps only each mark and the 5h percentage under 1024px", () => {
    stubWidth(1023);
    renderIndicator({ pessoal: live([claude(58), codexFree(37)]) });
    expect(agent("claude")).toHaveTextContent(/^58%$/);
    expect(agent("codex")).toHaveTextContent(/^37%$/);
    expect(within(button()).queryAllByRole("meter")).toHaveLength(0);
    expect(button()).toHaveAccessibleName("Usage: Claude Code 58% 5h; Codex 37% 30d");
  });

  it("flags another profile near or at its limit after a separator", () => {
    const { rerender } = renderIndicator({ pessoal: live([claude(10)]), trabalho: live([claude(85)]) });
    const alert = document.querySelector('[data-usage-alert="trabalho"]');
    expect(alert).toHaveAttribute("data-level", "warn");
    expect(alert?.querySelector(".bg-warn")).not.toBeNull();
    expect(alert?.previousElementSibling?.className).toContain("w-px");
    expect(button()).toHaveAccessibleName("Usage: Claude Code 10% 5h; Trabalho near the limit");

    rerender(
      <LocaleProvider>
        <UsageIndicator profileId="pessoal" profiles={PROFILES} byProfile={{ pessoal: live([claude(10)]), trabalho: live([claude(100)]) }} now={NOW} expanded={false} />
      </LocaleProvider>,
    );
    expect(document.querySelector('[data-usage-alert="trabalho"]')).toHaveAttribute("data-level", "limited");
    expect(button()).toHaveAccessibleName("Usage: Claude Code 10% 5h; Trabalho limit reached");
  });

  it("keeps an unreachable machine's last numbers, quieter, and says how old they are", () => {
    renderIndicator({ pessoal: live([claude(58)], { connection: "offline", receivedAt: NOW - 12 * MIN }) });
    expect(button()).toHaveAttribute("data-stale", "true");
    expect(agent("claude").className).toContain("opacity-60");
    expect(button()).toHaveAccessibleName("Usage: Claude Code 58% 5h; offline, last read 12m ago");
  });

  it("renders nothing without agents or alerts to show", () => {
    const { container, rerender } = renderIndicator({ pessoal: live([]) });
    expect(container).toBeEmptyDOMElement();
    for (const entry of [{ connection: "connecting", runtimes: null }] as const) {
      rerender(
        <LocaleProvider>
          <UsageIndicator profileId="pessoal" profiles={PROFILES} byProfile={{ pessoal: { ...live([]), ...entry } }} now={NOW} expanded={false} />
        </LocaleProvider>,
      );
      expect(container).toBeEmptyDOMElement();
    }
  });

  it("says the relay needs updating instead of vanishing on a relay too old for usage", () => {
    renderIndicator({ pessoal: { ...live([]), connection: "unsupported", runtimes: null } });
    expect(button()).toHaveTextContent("update relay");
    expect(button()).toHaveAccessibleName("Usage: this profile's relay is too old to report usage");
    expect(button()).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("speaks Portuguese", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "pt-BR");
    renderIndicator({ pessoal: live([claude(100)]), trabalho: live([claude(90)]) });
    expect(button()).toHaveAccessibleName("Uso: Claude Code esgotado, volta em 58m; Trabalho perto do limite");
    expect(agent("claude")).toHaveTextContent("volta em 58m");
  });

  it("hands the click to its owner and mirrors the open state", async () => {
    const onClick = vi.fn();
    renderIndicator({ pessoal: live([claude(58)]) }, { expanded: true, onClick });
    expect(button()).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(button());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("never pulses", () => {
    const { container } = renderIndicator({ pessoal: live([claude(100)]), trabalho: live([claude(100)]) });
    const classes = Array.from(container.querySelectorAll("*")).map((node) => node.getAttribute("class") ?? "");
    expect(classes.some((name) => /animate-/.test(name))).toBe(false);
  });
});
