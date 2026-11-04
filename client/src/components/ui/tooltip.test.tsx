import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

afterEach(() => cleanup());

function renderTooltip() {
  render(
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button">target</button>
        </TooltipTrigger>
        <TooltipContent>label</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
  return screen.getByRole("button", { name: "target" });
}

describe("Tooltip", () => {
  it("opens on hover", async () => {
    const trigger = renderTooltip();
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("label");
  });

  // Moving focus onto a trigger the person just clicked (selecting a tab does
  // this) is not a keyboard visit; the label must not pop up for it.
  it("does not open on a focus that is not :focus-visible", () => {
    const trigger = renderTooltip();
    trigger.matches = ((selector: string) => selector !== ":focus-visible");
    fireEvent.focus(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens on keyboard (:focus-visible) focus", async () => {
    const trigger = renderTooltip();
    trigger.matches = ((selector: string) => selector === ":focus-visible");
    fireEvent.focus(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("label");
  });
});
