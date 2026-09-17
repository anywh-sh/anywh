import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { CompactBoundaryToast } from "./CompactBoundaryToast";
import type { CompactBoundaryEvent } from "@/hooks/relay/useRelayClient";
import { en } from "@/i18n/en";

function event(overrides: Partial<CompactBoundaryEvent> = {}): CompactBoundaryEvent {
  return { trigger: "auto", preTokens: 100000, receivedAt: Date.now(), ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CompactBoundaryToast", () => {
  it("renders nothing when there is no event", () => {
    render(<CompactBoundaryToast event={null} />);
    expect(screen.queryByText(/compactad/i)).toBeNull();
  });

  it("shows the automatic-compaction copy for an auto trigger, then hides itself after the visible window", () => {
    render(<CompactBoundaryToast event={event({ trigger: "auto" })} />);
    expect(screen.getByText(en.chat.log.compactedAuto)).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText(/compactad/i)).toBeNull();
  });

  it("shows the manual-compaction copy for a manual trigger", () => {
    render(<CompactBoundaryToast event={event({ trigger: "manual" })} />);
    expect(screen.getByText(en.chat.log.compacted)).toBeInTheDocument();
  });

  it("re-shows and restarts the timer on a new occurrence, even with the same trigger/preTokens", () => {
    const first = event({ trigger: "auto", preTokens: 100000, receivedAt: 1000 });
    const { rerender } = render(<CompactBoundaryToast event={first} />);

    act(() => vi.advanceTimersByTime(3000)); // still visible, 1s away from hiding
    const second = event({ trigger: "auto", preTokens: 100000, receivedAt: 2000 });
    rerender(<CompactBoundaryToast event={second} />);

    // If the effect hadn't restarted (stale `receivedAt` treated as the same
    // occurrence), this would already be hidden by the first timer.
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText(en.chat.log.compactedAuto)).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText(/compactad/i)).toBeNull();
  });
});
