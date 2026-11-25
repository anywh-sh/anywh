import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import { ErrorMessage } from "./ErrorMessage";

afterEach(() => {
  cleanup();
});

const reconnect = { label: "Connect Claude Code", explanation: "Claude Code isn't signed in" };

describe("ErrorMessage", () => {
  it("carries the way back in when there is one, and nothing otherwise", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<ErrorMessage message="Not logged in" reconnect={{ ...reconnect, onClick }} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Connect Claude Code" }));
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<ErrorMessage message="Overloaded" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says a lost login in the app's own words, not the CLI's instruction for its terminal", () => {
    const { rerender } = render(<ErrorMessage message="Not logged in · Please run /login" reconnect={{ ...reconnect, onClick: () => {} }} />);
    expect(screen.getByText("Claude Code isn't signed in")).toBeInTheDocument();
    expect(screen.queryByText(/Please run \/login/)).not.toBeInTheDocument();
    rerender(<ErrorMessage message="Overloaded" />);
    expect(screen.getByText(en.chat.log.error.replace("{message}", "Overloaded"))).toBeInTheDocument();
  });
});
