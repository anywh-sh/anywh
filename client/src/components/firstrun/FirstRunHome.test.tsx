import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstRunHome } from "@/components/firstrun/FirstRunHome";
import { en } from "@/i18n/en";

const copy = en.firstRun.home;

afterEach(() => {
  cleanup();
});

describe("FirstRunHome", () => {
  it("hides path 01 entirely when there is no local path at all", () => {
    render(<FirstRunHome onPick={vi.fn()} local={{ kind: "hidden" }} />);
    expect(screen.queryByText(copy.localTitle)).not.toBeInTheDocument();
  });

  it("routes path 01 to the in-app install when it's fully available", async () => {
    const onPick = vi.fn();
    render(<FirstRunHome onPick={onPick} local={{ kind: "available" }} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: new RegExp(copy.localTitle) }));

    expect(onPick).toHaveBeenCalledWith("local");
    expect(screen.getByText(copy.localHint)).toBeInTheDocument();
  });

  it("offers guided terminal steps instead of the in-app install where there is no such install (macOS)", async () => {
    const onPick = vi.fn();
    render(<FirstRunHome onPick={onPick} local={{ kind: "guided" }} />);
    const user = userEvent.setup();

    expect(screen.getByText(copy.localHintGuided)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: new RegExp(copy.localTitle) }));

    expect(onPick).toHaveBeenCalledWith("manual");
  });
});
