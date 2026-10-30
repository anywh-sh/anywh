import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LOCALE_STORAGE_KEY, LocaleProvider } from "@/i18n";
import { UsageMeter } from "./UsageMeter";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const parts = (meter: HTMLElement, part: string): HTMLElement[] =>
  Array.from(meter.querySelectorAll<HTMLElement>(`[data-part="${part}"]`));

describe("UsageMeter", () => {
  it("is a meter with its range, value and an accessible name", () => {
    render(<UsageMeter percent={57.6} durationMins={300} />);
    const meter = screen.getByRole("meter", { name: "5h: 58% used" });
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
    expect(meter).toHaveAttribute("aria-valuenow", "58");
    expect(meter).toHaveAttribute("aria-valuetext", "58% used");
    expect(parts(meter, "fill")[0].style.width).toBe("58%");
  });

  it("speaks the interface's language", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "pt-BR");
    render(
      <LocaleProvider>
        <UsageMeter percent={58} durationMins={300} expected={60} />
      </LocaleProvider>,
    );
    const meter = screen.getByRole("meter", { name: "5h: 58% usado" });
    expect(meter).toHaveAttribute("aria-valuetext", "58% usado, esperado 60%");
  });

  it("draws the pace mark for the eye only and says it in the value text", () => {
    render(<UsageMeter percent={41} durationMins={10080} expected={50} />);
    const meter = screen.getByRole("meter", { name: "7d: 41% used" });
    expect(meter).toHaveAttribute("aria-valuetext", "41% used, 50% expected");
    const [pace] = parts(meter, "pace");
    expect(pace).toHaveAttribute("aria-hidden", "true");
    expect(pace.style.left).toBe("50%");
  });

  it("drops the pace mark once the window is spent", () => {
    render(<UsageMeter percent={100} durationMins={300} expected={70} />);
    const meter = screen.getByRole("meter");
    expect(parts(meter, "pace")).toHaveLength(0);
    expect(meter).toHaveAttribute("aria-valuetext", "100% used");
  });

  it("cuts the weekly window into days on the card, and nothing else", () => {
    const { rerender } = render(<UsageMeter percent={30} durationMins={10080} />);
    expect(parts(screen.getByRole("meter"), "cut")).toHaveLength(6);
    expect(parts(screen.getByRole("meter"), "cut").every((cut) => cut.getAttribute("aria-hidden") === "true")).toBe(true);
    rerender(<UsageMeter percent={30} durationMins={300} />);
    expect(parts(screen.getByRole("meter"), "cut")).toHaveLength(0);
    rerender(<UsageMeter percent={30} durationMins={10080} variant="indicator" />);
    expect(parts(screen.getByRole("meter"), "cut")).toHaveLength(0);
  });

  it("colors by level: neutral under 80, warn to 99, err at 100, warn on the agent's flag", () => {
    const fill = (): HTMLElement => parts(screen.getByRole("meter"), "fill")[0];
    const { rerender } = render(<UsageMeter percent={79} durationMins={300} />);
    expect(fill().className).toContain("bg-muted-foreground");
    rerender(<UsageMeter percent={80} durationMins={300} />);
    expect(fill().className).toContain("bg-warn");
    rerender(<UsageMeter percent={100} durationMins={300} />);
    expect(fill().className).toContain("bg-err");
    rerender(<UsageMeter percent={20} durationMins={300} warning />);
    expect(fill().className).toContain("bg-warn");
  });

  it("never animates and never rounds a corner", () => {
    const { container } = render(<UsageMeter percent={90} durationMins={10080} expected={40} />);
    const classes = Array.from(container.querySelectorAll("*")).map((node) => node.getAttribute("class") ?? "");
    expect(classes.some((name) => /animate-|transition|rounded-/.test(name))).toBe(false);
  });
});
