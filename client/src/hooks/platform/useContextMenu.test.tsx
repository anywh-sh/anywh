import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ContextMenuAnchor } from "@/hooks/platform/useContextMenu";

afterEach(() => {
  cleanup();
});

describe("ContextMenuAnchor", () => {
  // Pins down the actual mechanism behind the "context menu opens far from
  // the click" bug: a session tab's content sits inside `TabGroupLayout`'s
  // `contain: layout paint` wrapper, which turns any `position: fixed`
  // descendant's `left`/`top` into an offset from that wrapper instead of
  // the real viewport. happy-dom has no layout engine (can't assert the
  // resulting on-screen position), but it can assert the fix's actual
  // mechanism: the anchor renders straight into `document.body`, never
  // inside whatever local subtree it's called from — so no ancestor,
  // contained or not, is ever between it and the viewport.
  it("renders into document.body instead of its local subtree", () => {
    const { container } = render(
      <div data-testid="local-root">
        <DropdownMenu>
          <ContextMenuAnchor position={{ x: 10, y: 20 }} />
        </DropdownMenu>
      </div>,
    );

    expect(container.querySelector("span.pointer-events-none")).toBeNull();

    const anchor = document.body.querySelector<HTMLSpanElement>("span.pointer-events-none");
    expect(anchor).not.toBeNull();
    expect(anchor?.style.left).toBe("10px");
    expect(anchor?.style.top).toBe("20px");
  });
});
