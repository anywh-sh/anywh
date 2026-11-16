import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorMessage } from "./ErrorMessage";

afterEach(() => {
  cleanup();
});

describe("ErrorMessage", () => {
  it("carries the way back in when there is one, and nothing otherwise", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<ErrorMessage message="Not logged in" reconnect={{ label: "Sign Claude Code back in", onClick }} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign Claude Code back in" }));
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<ErrorMessage message="Overloaded" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
