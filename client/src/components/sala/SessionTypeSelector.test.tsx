import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { SessionTypeSelector, type SessionType } from "@/components/sala/SessionTypeSelector";
import { en } from "@/i18n/en";

afterEach(cleanup);

function Harness({ onChange }: { onChange?: (value: SessionType) => void }) {
  const [value, setValue] = useState<SessionType>("conversation");
  return (
    <SessionTypeSelector
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe("SessionTypeSelector", () => {
  it("is one radio group with the current type checked and as its only tab stop", () => {
    render(<Harness />);
    const conversation = screen.getByRole("radio", { name: en.sala.newSession.conversation });
    const room = screen.getByRole("radio", { name: en.sala.newSession.room });
    expect(conversation).toBeChecked();
    expect(conversation).toHaveAttribute("tabindex", "0");
    expect(room).toHaveAttribute("tabindex", "-1");
  });

  it("moves with the arrow keys, wrapping, and carries focus and the tab stop along", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Harness onChange={changed} />);
    screen.getByRole("radio", { name: en.sala.newSession.conversation }).focus();
    await user.keyboard("{ArrowRight}");
    expect(changed).toHaveBeenLastCalledWith("room");
    expect(screen.getByRole("radio", { name: en.sala.newSession.room })).toBeChecked();
    expect(screen.getByRole("radio", { name: en.sala.newSession.room })).toHaveFocus();
    expect(screen.getByRole("radio", { name: en.sala.newSession.room })).toHaveAttribute("tabindex", "0");
    await user.keyboard("{ArrowRight}");
    expect(changed).toHaveBeenLastCalledWith("conversation");
    await user.keyboard("{ArrowLeft}");
    expect(changed).toHaveBeenLastCalledWith("room");
  });

  it("changes on a click, and ignores other keys", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Harness onChange={changed} />);
    await user.click(screen.getByRole("radio", { name: en.sala.newSession.room }));
    expect(changed).toHaveBeenCalledWith("room");
    changed.mockClear();
    screen.getByRole("radio", { name: en.sala.newSession.room }).focus();
    await user.keyboard("a");
    expect(changed).not.toHaveBeenCalled();
  });
});
