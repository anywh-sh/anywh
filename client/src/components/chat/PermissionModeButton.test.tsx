import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PermissionModeButton } from "./PermissionModeButton";
import { en } from "@/i18n/en";

afterEach(() => cleanup());

const CLAUDE_MODES = [
  { id: "default", pausesForApproval: true },
  { id: "acceptEdits", pausesForApproval: true },
  { id: "plan", pausesForApproval: true },
  { id: "bypassPermissions", pausesForApproval: false },
];

describe("PermissionModeButton", () => {
  it("is disabled until the first permission_mode_state arrives (mode null, available empty)", () => {
    render(<PermissionModeButton mode={null} available={[]} onChange={vi.fn()} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("renders one menu item per entry of `available`, in the given order", async () => {
    const user = userEvent.setup();
    render(<PermissionModeButton mode="default" available={CLAUDE_MODES} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      en.chat.composer.mode.default.label + en.chat.composer.mode.default.hint,
      en.chat.composer.mode.acceptEdits.label + en.chat.composer.mode.acceptEdits.hint,
      en.chat.composer.mode.plan.label + en.chat.composer.mode.plan.hint,
      en.chat.composer.mode.bypassPermissions.label + en.chat.composer.mode.bypassPermissions.hint,
    ]);
  });

  it("switches mode from the menu", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PermissionModeButton mode="default" available={CLAUDE_MODES} onChange={onChange} />);

    await user.click(screen.getByRole("button"));
    await user.click(await screen.findByRole("menuitem", { name: new RegExp(en.chat.composer.mode.plan.label) }));

    expect(onChange).toHaveBeenCalledWith("plan");
  });

  it("an id this build has no copy for renders as the raw id with no hint, instead of crashing", async () => {
    const user = userEvent.setup();
    const codexModes = [
      { id: "read-only", pausesForApproval: true },
      { id: "some-future-mode", pausesForApproval: true },
    ];
    render(<PermissionModeButton mode="read-only" available={codexModes} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button"));
    const unknown = await screen.findByRole("menuitem", { name: "some-future-mode" });
    expect(unknown).toBeInTheDocument();
  });

  it("accents the trigger when the CURRENT mode never pauses for approval (Claude's bypassPermissions)", () => {
    render(<PermissionModeButton mode="bypassPermissions" available={CLAUDE_MODES} onChange={vi.fn()} />);
    expect(screen.getByRole("button").className).toMatch(/border-primary/);
  });

  it("accents the trigger the same way for a different agent's never-asks mode (Codex's full-access) — the concept generalizes, not the literal", () => {
    const codexModes = [
      { id: "read-only", pausesForApproval: true },
      { id: "workspace-write", pausesForApproval: true },
      { id: "full-access", pausesForApproval: false },
    ];
    render(<PermissionModeButton mode="full-access" available={codexModes} onChange={vi.fn()} />);
    expect(screen.getByRole("button").className).toMatch(/border-primary/);
  });

  it("does not accent the trigger for a mode that does pause for approval", () => {
    render(<PermissionModeButton mode="default" available={CLAUDE_MODES} onChange={vi.fn()} />);
    expect(screen.getByRole("button").className).not.toMatch(/border-primary/);
  });
});
