import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TitleBar } from "@/components/shell/TitleBar";
import { en } from "@/i18n/en";

afterEach(cleanup);

const noop = () => {};
const bar = (props: { showSidebarToggle?: boolean; sidebarCollapsed?: boolean; onToggleSidebar?: () => void } = {}) => (
  <TooltipProvider>
    <TitleBar showSidebarToggle sidebarCollapsed={false} onToggleSidebar={noop} onOpenSettings={noop} onCheckForUpdates={noop} {...props} />
  </TooltipProvider>
);

describe("TitleBar", () => {
  it("has the menu and the sidebar switch, and no history buttons", () => {
    render(bar());
    expect(screen.getByRole("button", { name: en.shell.titleBar.menu })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.shell.titleBar.collapseSidebar })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("keeps only the control that brings the sidebar back while it is folded away", () => {
    render(bar({ sidebarCollapsed: true }));
    expect(screen.queryByRole("button", { name: en.shell.titleBar.menu })).toBeNull();
    expect(screen.getByRole("button", { name: en.shell.titleBar.expandSidebar })).toBeInTheDocument();
  });

  it("keeps the menu where there is no sidebar switch to bring it back", () => {
    render(bar({ showSidebarToggle: false, sidebarCollapsed: true }));
    expect(screen.getByRole("button", { name: en.shell.titleBar.menu })).toBeInTheDocument();
  });
});

// The shortcut acts on the key going down; a click acts on the button coming
// back up. The sidebar's switch acts on the press, like the shortcut, so the
// two feel the same — and must still act exactly once for a click, and for the
// keyboard, which has no press to act on.
describe("TitleBar — the sidebar switch", () => {
  const toggle = () => screen.getByRole("button", { name: en.shell.titleBar.collapseSidebar });

  it("acts on the press, before the button comes back up", () => {
    const onToggleSidebar = vi.fn();
    render(bar({ onToggleSidebar }));
    fireEvent.pointerDown(toggle(), { button: 0 });
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("acts once for a whole click, not once for the press and again for the release", async () => {
    const onToggleSidebar = vi.fn();
    render(bar({ onToggleSidebar }));
    await userEvent.setup().click(toggle());
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("still acts for a click that comes from the keyboard, which has no press", async () => {
    const onToggleSidebar = vi.fn();
    render(bar({ onToggleSidebar }));
    toggle().focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("does not act on a press of another button", () => {
    const onToggleSidebar = vi.fn();
    render(bar({ onToggleSidebar }));
    fireEvent.pointerDown(toggle(), { button: 2 });
    expect(onToggleSidebar).not.toHaveBeenCalled();
  });
});
