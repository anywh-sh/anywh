import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandLine } from "@/components/firstrun/CommandLine";
import { OnboardingFrame } from "@/components/firstrun/OnboardingFrame";
import { Segmented } from "@/components/firstrun/Segmented";
import { Stepper } from "@/components/firstrun/Stepper";
import { en } from "@/i18n/en";
import { ptBr } from "@/i18n/pt-br";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const STEPS = [
  { id: "machine", label: "This machine" },
  { id: "agents", label: "Your agents" },
];

describe("Stepper", () => {
  it("marks only the current step and shows a check on the ones before it", () => {
    render(<Stepper steps={STEPS} current="agents" />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).not.toHaveAttribute("aria-current");
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[0].querySelector("svg")).not.toBeNull();
    expect(items[1].querySelector("svg")).toBeNull();
  });
});

describe("Segmented", () => {
  it("reports the picked option and reflects the selection", async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        id="mode"
        label="How"
        value="code"
        options={[
          { value: "code", label: "Code" },
          { value: "address", label: "Address" },
        ]}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    await userEvent.setup().click(screen.getByRole("tab", { name: "Address" }));
    expect(onChange).toHaveBeenCalledWith("address");
  });
});

describe("CommandLine", () => {
  it("copies the command, says so, and goes back to Copy after 1.5 s", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CommandLine command="brew install anywh-sh/tap/anywh-relay" />);

    await act(async () => {
      screen.getByRole("button", { name: en.firstRun.copy.copy }).click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("brew install anywh-sh/tap/anywh-relay");
    expect(screen.getByRole("button", { name: en.firstRun.copy.copied })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole("button", { name: en.firstRun.copy.copy })).toBeInTheDocument();
  });

  it("shows the failure word when the clipboard refuses", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CommandLine command="codex login" />);
    // Not `userEvent.setup()`: it installs its own clipboard stub over ours.
    await act(async () => {
      screen.getByRole("button", { name: en.firstRun.copy.copy }).click();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: en.firstRun.copy.failed })).toBeInTheDocument();
  });
});

describe("OnboardingFrame", () => {
  it("renders the content, the wordmark and the footer's Help; Back only when there is somewhere to go", async () => {
    const onBack = vi.fn();
    const { rerender } = render(<OnboardingFrame>hello</OnboardingFrame>);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("anywh.sh")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.firstRun.frame.help })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.firstRun.frame.back })).not.toBeInTheDocument();

    rerender(
      <OnboardingFrame onBack={onBack} steps={STEPS} current="machine">
        hello
      </OnboardingFrame>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: en.firstRun.frame.back }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("list", { name: en.firstRun.frame.steps.label })).toBeInTheDocument();
  });
});

describe("onboarding copy", () => {
  it("has the same shape in both languages", () => {
    for (const key of ["frame", "copy", "profile"] as const) {
      expect(Object.keys(ptBr.firstRun[key]).sort()).toEqual(Object.keys(en.firstRun[key]).sort());
    }
    expect(ptBr.firstRun.frame.steps).not.toEqual(en.firstRun.frame.steps);
  });
});
