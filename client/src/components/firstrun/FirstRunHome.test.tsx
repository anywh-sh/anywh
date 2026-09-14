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

  it("routes path 01 to the in-app install when it's fully available (Linux or macOS)", async () => {
    const onPick = vi.fn();
    render(<FirstRunHome onPick={onPick} local={{ kind: "available" }} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: new RegExp(copy.localTitle) }));

    expect(onPick).toHaveBeenCalledWith("local");
    expect(screen.getByText(copy.localHint)).toBeInTheDocument();
  });

  it("shows the card disabled with a reason inside a sandbox that can't reach the host's service manager", () => {
    render(<FirstRunHome onPick={vi.fn()} local={{ kind: "unavailable", reason: "flatpak" }} />);
    expect(screen.getByText("flatpak")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(copy.localTitle) })).toBeDisabled();
  });
});
