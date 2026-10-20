import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TitleBar } from "@/components/shell/TitleBar";
import { en } from "@/i18n/en";

afterEach(cleanup);

const noop = () => {};
const bar = (props: { showSidebarToggle?: boolean; sidebarCollapsed?: boolean } = {}) => (
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
